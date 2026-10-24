import { sql, runAudienceQuery } from "../db";

/**
 * Lifecycle candidate-audience builders + the cached store digest used as AI context.
 *
 * Each builder returns a single-SELECT `audienceSql` (customer_id column, literal
 * `store_id = '<uuid>'` filter) that is stored on the brief and re-validated and executed
 * later through `runAudienceQuery()`. No PII ever leaves this module: the AI sees only
 * aggregate stats and product ids.
 */

export const LIFECYCLE_JOBS = ["cart_recovery", "second_purchase", "winback", "affinity"] as const;
export type LifecycleJob = (typeof LIFECYCLE_JOBS)[number];

export type AudienceStats = {
  count: number;
  avg_total_spent: number;
  avg_orders: number;
  top_product_types: { product_type: string; customers: number }[];
};

export type Candidate = {
  audienceSql: string;
  stats: AudienceStats & { signals: Record<string, number | string> };
  productIds: string[];
  /** Suggested discount, e.g. "10%". Only a suggestion; the merchant approves or removes it. */
  defaultDiscount?: string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** storeId is interpolated into audience SQL as a literal, so it must be a strict uuid. */
function lit(storeId: string): string {
  if (!UUID_RE.test(storeId)) throw new Error("invalid store id");
  return storeId.toLowerCase();
}

const num = (v: string | number | null | undefined, digits = 2): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Number(n.toFixed(digits)) : 0;
};

const ACTIVE = sql`coalesce(upper(p.status), 'ACTIVE') = 'ACTIVE'`;

// ---------------------------------------------------------------------------
// Audience stats
// ---------------------------------------------------------------------------

async function statsForIds(storeId: string, ids: string[]): Promise<AudienceStats> {
  if (ids.length === 0) return { count: 0, avg_total_spent: 0, avg_orders: 0, top_product_types: [] };

  const [agg] = await sql<{ n: string; avg_spent: string | null; avg_orders: string | null }[]>`
    select count(*)::text as n, avg(total_spent)::text as avg_spent, avg(orders_count)::text as avg_orders
    from customers
    where store_id = ${storeId} and id = any(${ids}::uuid[])`;

  const types = await sql<{ product_type: string; customers: number }[]>`
    select p.product_type, count(distinct o.customer_id)::int as customers
    from order_lines ol
    join orders o on o.id = ol.order_id and o.store_id = ol.store_id
    join products p on p.id = ol.product_id and p.store_id = ol.store_id
    where ol.store_id = ${storeId}
      and o.customer_id = any(${ids}::uuid[])
      and o.cancelled_at is null
      and p.product_type is not null and p.product_type <> ''
    group by p.product_type
    order by customers desc, p.product_type asc
    limit 5`;

  return {
    count: Number(agg?.n ?? 0),
    avg_total_spent: num(agg?.avg_spent),
    avg_orders: num(agg?.avg_orders),
    top_product_types: types.map((t) => ({ product_type: t.product_type, customers: t.customers })),
  };
}

/** Aggregate, anonymised stats for an audience query (runs through runAudienceQuery). */
export async function computeAudienceStats(storeId: string, audienceSql: string): Promise<AudienceStats> {
  const ids = await runAudienceQuery(storeId, audienceSql);
  return statsForIds(storeId, ids);
}

// ---------------------------------------------------------------------------
// Product candidate helpers
// ---------------------------------------------------------------------------

async function bestsellerIds(storeId: string, limit: number, types: string[] = []): Promise<string[]> {
  const typeFilter = types.length > 0 ? sql`and p.product_type = any(${types}::text[])` : sql``;
  const rows = await sql<{ id: string }[]>`
    select p.id::text as id
    from products p
    left join (
      select ol.product_id, sum(ol.quantity) as units
      from order_lines ol
      join orders o on o.id = ol.order_id and o.store_id = ol.store_id
      where ol.store_id = ${storeId} and o.cancelled_at is null
        and o.processed_at > now() - interval '180 days'
      group by ol.product_id
    ) s on s.product_id = p.id
    where p.store_id = ${storeId} and ${ACTIVE} ${typeFilter}
    order by coalesce(s.units, 0) desc, p.title asc, p.id asc
    limit ${limit}`;
  return rows.map((r) => r.id);
}

async function purchasedByCohort(storeId: string, ids: string[], limit: number): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await sql<{ id: string }[]>`
    select p.id::text as id
    from order_lines ol
    join orders o on o.id = ol.order_id and o.store_id = ol.store_id
    join products p on p.id = ol.product_id and p.store_id = ol.store_id
    where ol.store_id = ${storeId} and o.customer_id = any(${ids}::uuid[])
      and o.cancelled_at is null and ${ACTIVE}
    group by p.id, p.title
    order by count(distinct o.customer_id) desc, p.title asc, p.id asc
    limit ${limit}`;
  return rows.map((r) => r.id);
}

/**
 * Products the cohort has not (mostly) bought, ranked by co-occurrence with what they did buy.
 * Falls back to store bestsellers (within `types` when given).
 */
async function recommendForCohort(
  storeId: string,
  ids: string[],
  limit: number,
  types: string[] = [],
): Promise<string[]> {
  let out: string[] = [];
  if (ids.length > 0) {
    const maxBuyers = Math.max(1, Math.floor(ids.length * 0.25));
    const typeFilter = types.length > 0 ? sql`and p.product_type = any(${types}::text[])` : sql``;
    const rows = await sql<{ id: string }[]>`
      with bought as (
        select ol.product_id, count(distinct o.customer_id)::int as buyers
        from order_lines ol
        join orders o on o.id = ol.order_id and o.store_id = ol.store_id
        where ol.store_id = ${storeId} and o.customer_id = any(${ids}::uuid[])
          and o.cancelled_at is null and ol.product_id is not null
        group by ol.product_id
      ), cand as (
        select pc.product_b as product_id, sum(pc.count::bigint * b.buyers) as score
        from product_cooccurrence pc
        join bought b on b.product_id = pc.product_a
        where pc.store_id = ${storeId}
        group by pc.product_b
      )
      select p.id::text as id
      from cand c
      join products p on p.id = c.product_id and p.store_id = ${storeId}
      left join bought bb on bb.product_id = p.id
      where ${ACTIVE} ${typeFilter} and coalesce(bb.buyers, 0) <= ${maxBuyers}::int
      order by c.score desc, p.title asc, p.id asc
      limit ${limit}`;
    out = rows.map((r) => r.id);
  }
  if (out.length < limit) {
    const fill = await bestsellerIds(storeId, limit * 2, types);
    for (const id of fill) {
      if (out.length >= limit) break;
      if (!out.includes(id)) out.push(id);
    }
  }
  return out;
}

async function finalize(
  storeId: string,
  audienceSql: string,
  opts: {
    signals?: (ids: string[]) => Promise<Record<string, number | string>>;
    products: (ids: string[], stats: AudienceStats) => Promise<string[]>;
    defaultDiscount?: string;
  },
): Promise<Candidate> {
  const ids = await runAudienceQuery(storeId, audienceSql);
  const stats = await statsForIds(storeId, ids);
  const signals = ids.length > 0 && opts.signals ? await opts.signals(ids) : {};
  const productIds = ids.length > 0 ? await opts.products(ids, stats) : [];
  return {
    audienceSql,
    stats: { ...stats, signals },
    productIds,
    ...(opts.defaultDiscount ? { defaultDiscount: opts.defaultDiscount } : {}),
  };
}

// ---------------------------------------------------------------------------
// The four lifecycle jobs
// ---------------------------------------------------------------------------

/** Checkout started 2-48h ago, not followed by an order, subscribed + emailable. */
export async function cartRecovery(storeId: string): Promise<Candidate> {
  const sid = lit(storeId);
  const audienceSql = `select distinct a.customer_id
from v_abandoned_checkouts a
join customers c on c.id = a.customer_id and c.store_id = a.store_id
where a.store_id = '${sid}'
  and a.occurred_at <= now() - interval '2 hours'
  and a.occurred_at >= now() - interval '48 hours'
  and c.marketing_state = 'subscribed' and c.email is not null`;

  return finalize(sid, audienceSql, {
    signals: async (ids) => {
      const [r] = await sql<{ hours: string | null }[]>`
        select (avg(extract(epoch from (now() - a.occurred_at))) / 3600.0)::text as hours
        from v_abandoned_checkouts a
        where a.store_id = ${sid} and a.customer_id = any(${ids}::uuid[])`;
      return { avg_hours_since_checkout: num(r?.hours, 1) };
    },
    products: async (ids) => {
      const rows = await sql<{ id: string }[]>`
        select p.id::text as id
        from v_abandoned_checkouts a
        join products p on p.id = a.product_id and p.store_id = a.store_id
        where a.store_id = ${sid} and a.customer_id = any(${ids}::uuid[]) and ${ACTIVE}
        group by p.id, p.title
        order by count(*) desc, p.title asc, p.id asc
        limit 8`;
      const out = rows.map((r) => r.id);
      if (out.length > 0) return out;
      return bestsellerIds(sid, 4);
    },
  });
}

/** Exactly one order, first order 7-30 days ago. */
export async function secondPurchase(storeId: string): Promise<Candidate> {
  const sid = lit(storeId);
  const audienceSql = `select c.id as customer_id
from customers c
where c.store_id = '${sid}'
  and c.orders_count = 1
  and c.first_order_at <= now() - interval '7 days'
  and c.first_order_at >= now() - interval '30 days'
  and c.marketing_state = 'subscribed' and c.email is not null`;

  return finalize(sid, audienceSql, {
    signals: async (ids) => {
      const [r] = await sql<{ days: string | null }[]>`
        select avg(extract(epoch from (now() - first_order_at)) / 86400.0)::text as days
        from customers where store_id = ${sid} and id = any(${ids}::uuid[])`;
      return { avg_days_since_first_order: num(r?.days, 1) };
    },
    products: (ids) => recommendForCohort(sid, ids, 8),
  });
}

/** High churn risk or due for a reorder, and no order in 45+ days. */
export async function winback(storeId: string): Promise<Candidate> {
  const sid = lit(storeId);
  const audienceSql = `select s.customer_id
from customer_scores s
join customers c on c.id = s.customer_id and c.store_id = s.store_id
where s.store_id = '${sid}'
  and (s.churn_risk > 0.6
       or s.predicted_reorder_at between current_date - 7 and current_date + 7)
  and c.last_order_at < now() - interval '45 days'
  and c.marketing_state = 'subscribed' and c.email is not null`;

  return finalize(sid, audienceSql, {
    defaultDiscount: "10%",
    signals: async (ids) => {
      const [r] = await sql<{ churn: string | null; days: string | null; due: string }[]>`
        select avg(churn_risk)::text as churn, avg(recency_days)::text as days,
               (count(*) filter (where predicted_reorder_at between current_date - 7 and current_date + 7))::text as due
        from customer_scores where store_id = ${sid} and customer_id = any(${ids}::uuid[])`;
      return {
        avg_churn_risk: num(r?.churn, 2),
        avg_days_since_last_order: num(r?.days, 0),
        due_for_reorder: Number(r?.due ?? 0),
      };
    },
    products: async (ids) => {
      const bought = await purchasedByCohort(sid, ids, 6);
      if (bought.length >= 4) return bought;
      const extra = await recommendForCohort(sid, ids, 6);
      return [...bought, ...extra.filter((id) => !bought.includes(id))].slice(0, 8);
    },
  });
}

/** Customers with a clear product-type preference who are still active; suggest unbought items in those types. */
export async function affinity(storeId: string): Promise<Candidate> {
  const sid = lit(storeId);
  const audienceSql = `select s.customer_id
from customer_scores s
join customers c on c.id = s.customer_id and c.store_id = s.store_id
where s.store_id = '${sid}'
  and cardinality(s.top_product_types) > 0
  and s.churn_risk <= 0.6
  and c.last_order_at <= now() - interval '14 days'
  and c.last_order_at >= now() - interval '180 days'
  and c.marketing_state = 'subscribed' and c.email is not null`;

  return finalize(sid, audienceSql, {
    signals: async (ids) => {
      const rows = await sql<{ t: string; n: number }[]>`
        select t as t, count(*)::int as n
        from customer_scores, unnest(top_product_types) as t
        where store_id = ${sid} and customer_id = any(${ids}::uuid[])
        group by t order by n desc, t asc limit 3`;
      return Object.fromEntries(rows.map((r) => [`preferred_type_${r.t}`, r.n]));
    },
    products: async (ids, stats) => {
      const types = stats.top_product_types.slice(0, 3).map((t) => t.product_type);
      return recommendForCohort(sid, ids, 8, types);
    },
  });
}

export const LIFECYCLE_BUILDERS: Record<LifecycleJob, (storeId: string) => Promise<Candidate>> = {
  cart_recovery: cartRecovery,
  second_purchase: secondPurchase,
  winback,
  affinity,
};

export function isLifecycleJob(v: unknown): v is LifecycleJob {
  return typeof v === "string" && (LIFECYCLE_JOBS as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Store digest (cached AI context)
// ---------------------------------------------------------------------------

const DIGEST_TTL_MS = 60 * 60 * 1000;
const digestCache = new Map<string, { at: number; value: string }>();

export function invalidateStoreDigest(storeId?: string) {
  if (storeId) digestCache.delete(storeId);
  else digestCache.clear();
}

const clean = (v: string | null | undefined) => (v ?? "").replace(/\s+/g, " ").trim();
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Deterministic, byte-stable description of the store for the cached system prefix.
 * Sorted keys, no timestamps, counts bucketed so it does not change on every order.
 * Cached in-memory per process for 1 hour.
 */
export async function getStoreDigest(storeId: string): Promise<string> {
  const hit = digestCache.get(storeId);
  if (hit && Date.now() - hit.at < DIGEST_TTL_MS) return hit.value;

  const [store] = await sql<
    {
      name: string;
      timezone: string;
      from_name: string | null;
      brand_primary: string | null;
      brand_font: string | null;
    }[]
  >`select name, timezone, from_name, brand_primary, brand_font from stores where id = ${storeId} limit 1`;
  if (!store) throw new Error(`store ${storeId} not found`);

  const [catalog] = await sql<{ n: string }[]>`
    select count(*)::text as n from products p where p.store_id = ${storeId} and ${ACTIVE}`;

  const types = await sql<{ product_type: string; n: number }[]>`
    select p.product_type, count(*)::int as n
    from products p
    where p.store_id = ${storeId} and ${ACTIVE} and p.product_type is not null and p.product_type <> ''
    group by p.product_type
    order by n desc, p.product_type asc
    limit 20`;

  const tags = await sql<{ tag: string; n: number }[]>`
    select t as tag, count(*)::int as n
    from products p, unnest(p.tags) as t
    where p.store_id = ${storeId} and ${ACTIVE}
    group by t
    order by n desc, t asc
    limit 12`;

  const top = await sql<
    {
      title: string;
      product_type: string | null;
      price_min: string | null;
      price_max: string | null;
      url: string | null;
      image_url: string | null;
    }[]
  >`
    select p.title, p.product_type, p.price_min, p.price_max, p.url, p.image_url
    from products p
    left join (
      select ol.product_id, sum(ol.quantity) as units
      from order_lines ol
      join orders o on o.id = ol.order_id and o.store_id = ol.store_id
      where ol.store_id = ${storeId} and o.cancelled_at is null
        and o.processed_at > now() - interval '365 days'
      group by ol.product_id
    ) s on s.product_id = p.id
    where p.store_id = ${storeId} and ${ACTIVE}
    order by coalesce(s.units, 0) desc, p.title asc, p.id asc
    limit 40`;

  const [orders] = await sql<{ n: string; aov: string | null; currency: string | null }[]>`
    select count(*)::text as n,
           avg(total_price)::text as aov,
           (select o2.currency from orders o2
             where o2.store_id = ${storeId} and o2.currency is not null
             group by o2.currency order by count(*) desc, o2.currency asc limit 1) as currency
    from orders where store_id = ${storeId} and cancelled_at is null`;

  const orderCount = Number(orders?.n ?? 0);
  const orderBucket = orderCount >= 10 ? Math.floor(orderCount / 10) * 10 : orderCount;
  const aov = Math.round(Number(orders?.aov ?? 0));

  const price = (min: string | null, max: string | null) => {
    if (min == null && max == null) return "n/a";
    const lo = num(min ?? max);
    const hi = num(max ?? min);
    return lo === hi ? `${lo.toFixed(2)}` : `${lo.toFixed(2)}-${hi.toFixed(2)}`;
  };

  const fields: Record<string, string> = {
    average_order_value: `${aov} ${orders?.currency ?? ""}`.trim(),
    brand_font: clean(store.brand_font) || "n/a",
    brand_primary_color: clean(store.brand_primary) || "n/a",
    catalog_size_active_products: String(Number(catalog?.n ?? 0)),
    order_count_approx: String(orderBucket),
    sender_name: clean(store.from_name) || clean(store.name),
    store_name: clean(store.name),
    timezone: store.timezone,
    top_product_tags: tags.map((t) => t.tag).join(", ") || "n/a",
    product_types: types.map((t) => `${t.product_type} (${t.n})`).join(", ") || "n/a",
  };

  const lines = ["STORE DIGEST", ...Object.keys(fields).sort(byText).map((k) => `${k}: ${fields[k]}`)];
  lines.push("", "TOP PRODUCTS (title | type | price | url | image)");
  const rows = top
    .map((p) =>
      [clean(p.title), clean(p.product_type) || "n/a", price(p.price_min, p.price_max), clean(p.url) || "n/a", clean(p.image_url) || "n/a"].join(
        " | ",
      ),
    )
    .sort(byText);
  for (const r of rows) lines.push(`- ${r}`);

  const value = lines.join("\n");
  digestCache.set(storeId, { at: Date.now(), value });
  return value;
}
