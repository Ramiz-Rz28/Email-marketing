-- 0002_scoring.sql — customer scoring (RFM, repurchase/churn heuristics), product
-- co-occurrence, and abandoned-checkout view. Plain Postgres; runs on Supabase.
-- Every table is store-scoped; refresh functions take the store id explicitly.

-- ---------------------------------------------------------------------------
-- customer_scores: one row per customer, recomputed nightly
-- ---------------------------------------------------------------------------
create table if not exists customer_scores (
  store_id             uuid not null references stores(id) on delete cascade,
  customer_id          uuid not null references customers(id) on delete cascade,
  recency_days         int,
  frequency            int not null default 0,
  monetary             numeric(12,2) not null default 0,
  rfm_segment          text,
  repurchase_score     numeric(5,4),
  churn_risk           numeric(5,4),
  predicted_reorder_at date,
  top_product_types    text[] not null default '{}',
  affinity             jsonb not null default '{}'::jsonb,   -- { product_type: units bought }
  computed_at          timestamptz not null default now(),
  primary key (store_id, customer_id)
);
create index if not exists customer_scores_store_churn_idx
  on customer_scores (store_id, churn_risk desc);
create index if not exists customer_scores_store_reorder_idx
  on customer_scores (store_id, predicted_reorder_at);

-- ---------------------------------------------------------------------------
-- v_customer_rfm: quintiles (5 = best) computed within each store
--   recency: fewer days since last order => higher score
--   frequency / monetary: more => higher score (ties broken deterministically)
-- ---------------------------------------------------------------------------
create or replace view v_customer_rfm as
select
  q.store_id,
  q.customer_id,
  q.recency_days,
  q.frequency,
  q.monetary,
  q.first_order_at,
  q.last_order_at,
  q.r_score,
  q.f_score,
  q.m_score,
  case
    when q.frequency = 1 and q.r_score >= 4 then 'New'
    when q.r_score >= 4 and q.f_score >= 4 then 'Champions'
    when q.r_score >= 3 and q.f_score >= 3 then 'Loyal'
    when q.r_score >= 3 then 'Potential'
    when q.r_score <= 2 and q.f_score >= 3 then 'At Risk'
    when q.r_score = 2 then 'Hibernating'
    else 'Lost'
  end as rfm_segment
from (
  select
    b.store_id,
    b.customer_id,
    b.recency_days,
    b.frequency,
    b.monetary,
    b.first_order_at,
    b.last_order_at,
    ntile(5) over (partition by b.store_id order by b.recency_days desc, b.customer_id) as r_score,
    ntile(5) over (partition by b.store_id order by b.frequency asc, b.monetary asc, b.customer_id) as f_score,
    ntile(5) over (partition by b.store_id order by b.monetary asc, b.frequency asc, b.customer_id) as m_score
  from (
    select
      c.store_id,
      c.id as customer_id,
      greatest(0, (current_date - c.last_order_at::date))::int as recency_days,
      c.orders_count as frequency,
      c.total_spent as monetary,
      c.first_order_at,
      c.last_order_at
    from customers c
    where c.last_order_at is not null
  ) b
) q;

-- ---------------------------------------------------------------------------
-- refresh_customer_scores(p_store): upsert scores for every purchaser in the store
-- ---------------------------------------------------------------------------
create or replace function refresh_customer_scores(p_store uuid) returns int
language plpgsql
as $$
declare
  v_store_median double precision;
  v_count int;
begin
  -- Store-wide median days between consecutive orders of the same customer.
  select percentile_cont(0.5) within group (order by g.gap_days)
    into v_store_median
  from (
    select extract(epoch from (x.processed_at - x.prev_at))::double precision / 86400.0 as gap_days
    from (
      select o.processed_at,
             lag(o.processed_at) over (partition by o.customer_id order by o.processed_at) as prev_at
      from orders o
      where o.store_id = p_store and o.customer_id is not null and o.cancelled_at is null
    ) x
    where x.prev_at is not null and x.processed_at > x.prev_at
  ) g;
  v_store_median := coalesce(v_store_median, 60);

  insert into customer_scores (
    store_id, customer_id, recency_days, frequency, monetary, rfm_segment,
    repurchase_score, churn_risk, predicted_reorder_at, top_product_types, affinity, computed_at
  )
  select
    r.store_id,
    r.customer_id,
    r.recency_days,
    r.frequency,
    r.monetary,
    r.rfm_segment,
    round(rp.rep::numeric, 4),
    round(least(1, greatest(0,
      0.6 * (1 - rp.rep)
      + 0.4 * least(1, r.recency_days::double precision / greatest(gp.gap_days * 3, 90))
    ))::numeric, 4),
    (r.last_order_at::date + round(gp.gap_days)::int),
    coalesce(tt.top_types, '{}'::text[]),
    coalesce(tt.affinity, '{}'::jsonb),
    now()
  from v_customer_rfm r
  left join (
    select y.customer_id, percentile_cont(0.5) within group (order by y.gap_days) as median_gap
    from (
      select z.customer_id,
             extract(epoch from (z.processed_at - z.prev_at))::double precision / 86400.0 as gap_days
      from (
        select o.customer_id, o.processed_at,
               lag(o.processed_at) over (partition by o.customer_id order by o.processed_at) as prev_at
        from orders o
        where o.store_id = p_store and o.customer_id is not null and o.cancelled_at is null
      ) z
      where z.prev_at is not null and z.processed_at > z.prev_at
    ) y
    group by y.customer_id
  ) g on g.customer_id = r.customer_id
  left join (
    select t.customer_id,
           (array_agg(t.product_type order by t.n desc, t.product_type) filter (where t.rn <= 3)) as top_types,
           jsonb_object_agg(t.product_type, t.n) as affinity
    from (
      select u.customer_id, u.product_type, u.n,
             row_number() over (partition by u.customer_id order by u.n desc, u.product_type) as rn
      from (
        select o.customer_id, p.product_type, sum(ol.quantity)::int as n
        from order_lines ol
        join orders o on o.id = ol.order_id and o.store_id = ol.store_id
        join products p on p.id = ol.product_id and p.store_id = ol.store_id
        where ol.store_id = p_store
          and o.customer_id is not null
          and o.cancelled_at is null
          and p.product_type is not null
          and p.product_type <> ''
        group by o.customer_id, p.product_type
      ) u
    ) t
    group by t.customer_id
  ) tt on tt.customer_id = r.customer_id
  cross join lateral (
    select greatest(coalesce(g.median_gap, v_store_median), 1.0)::double precision as gap_days
  ) gp
  cross join lateral (
    -- repurchase heuristic: frequency weight (saturates at 5 orders) + exponential recency decay
    select least(1, greatest(0,
      0.4 * least(1, ln(1 + r.frequency::double precision) / ln(6::double precision))
      + 0.6 * exp(- r.recency_days::double precision / greatest(gp.gap_days * 2, 30))
    )) as rep
  ) rp
  where r.store_id = p_store
  on conflict (store_id, customer_id) do update set
    recency_days         = excluded.recency_days,
    frequency            = excluded.frequency,
    monetary             = excluded.monetary,
    rfm_segment          = excluded.rfm_segment,
    repurchase_score     = excluded.repurchase_score,
    churn_risk           = excluded.churn_risk,
    predicted_reorder_at = excluded.predicted_reorder_at,
    top_product_types    = excluded.top_product_types,
    affinity             = excluded.affinity,
    computed_at          = excluded.computed_at;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- product_cooccurrence: how often two products are bought in the same order
-- (stored in both directions so lookups by product_a are enough)
-- ---------------------------------------------------------------------------
create table if not exists product_cooccurrence (
  store_id   uuid not null references stores(id) on delete cascade,
  product_a  uuid not null references products(id) on delete cascade,
  product_b  uuid not null references products(id) on delete cascade,
  count      int not null default 0,
  primary key (store_id, product_a, product_b)
);
create index if not exists product_cooccurrence_store_a_idx
  on product_cooccurrence (store_id, product_a, count desc);

create or replace function refresh_product_cooccurrence(p_store uuid) returns int
language plpgsql
as $$
declare
  v_count int;
begin
  delete from product_cooccurrence where store_id = p_store;

  insert into product_cooccurrence (store_id, product_a, product_b, count)
  select p_store, a.product_id, b.product_id, count(distinct a.order_id)::int
  from order_lines a
  join order_lines b
    on b.order_id = a.order_id
   and b.store_id = a.store_id
   and b.product_id <> a.product_id
  join orders o on o.id = a.order_id and o.store_id = a.store_id
  where a.store_id = p_store
    and a.product_id is not null
    and b.product_id is not null
    and o.cancelled_at is null
  group by a.product_id, b.product_id;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- v_abandoned_checkouts: checkout_started in the last 72h with no later order
-- by the same customer. Callers apply their own age window and consent filters.
-- ---------------------------------------------------------------------------
create or replace view v_abandoned_checkouts as
select
  e.id as event_id,
  e.store_id,
  e.customer_id,
  e.product_id,
  e.props,
  e.occurred_at
from events e
where e.type = 'checkout_started'
  and e.customer_id is not null
  and e.occurred_at > now() - interval '72 hours'
  and not exists (
    select 1
    from events o
    where o.store_id = e.store_id
      and o.customer_id = e.customer_id
      and o.type = 'order_placed'
      and o.occurred_at > e.occurred_at
  );
