-- 0001_init.sql — core multi-tenant schema for the lifecycle email app.
-- Tenant = store. Every tenant-owned table carries store_id and is queried
-- through src/lib/db.ts helpers that always scope by store_id.

create extension if not exists pgcrypto;
create extension if not exists citext;

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------
create table if not exists stores (
  id              uuid primary key default gen_random_uuid(),
  clerk_org_id    text not null unique,
  name            text not null,
  -- brand kit injected into templates
  brand_logo_url  text,
  brand_primary   text default '#111111',
  brand_font      text default 'Inter, Arial, sans-serif',
  from_name       text,
  from_email      text,
  reply_to        text,
  timezone        text not null default 'America/Toronto',
  -- guardrails enforced server-side regardless of AI output
  max_emails_per_customer_per_week int not null default 2,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists shopify_connections (
  id              uuid primary key default gen_random_uuid(),
  store_id        uuid not null references stores(id) on delete cascade,
  shop_domain     text not null,                      -- zahriya.myshopify.com
  access_token    text not null,                      -- offline token
  scopes          text not null,
  webhook_ids     jsonb not null default '[]'::jsonb,
  installed_at    timestamptz not null default now(),
  uninstalled_at  timestamptz,
  last_backfill_at timestamptz,
  unique (store_id),
  unique (shop_domain)
);

-- ---------------------------------------------------------------------------
-- Commerce mirror (Shopify is system of record; we keep what marketing needs)
-- ---------------------------------------------------------------------------
create table if not exists products (
  id              uuid primary key default gen_random_uuid(),
  store_id        uuid not null references stores(id) on delete cascade,
  shopify_id      text not null,                      -- gid://shopify/Product/123
  handle          text,
  title           text not null,
  product_type    text,
  vendor          text,
  tags            text[] not null default '{}',
  image_url       text,
  url             text,
  price_min       numeric(12,2),
  price_max       numeric(12,2),
  status          text,                               -- ACTIVE / DRAFT / ARCHIVED
  updated_at      timestamptz not null default now(),
  unique (store_id, shopify_id)
);

create table if not exists customers (
  id                  uuid primary key default gen_random_uuid(),
  store_id            uuid not null references stores(id) on delete cascade,
  shopify_id          text,                            -- gid://shopify/Customer/123 (null for anonymous)
  email               citext,
  first_name          text,
  last_name           text,
  -- consent: ONLY 'subscribed' may receive marketing. Mirrors Shopify emailMarketingConsent.
  marketing_state     text not null default 'not_subscribed'
                        check (marketing_state in ('subscribed','not_subscribed','unsubscribed','pending','invalid')),
  marketing_opt_in_level text,                         -- single_opt_in / confirmed_opt_in
  consent_updated_at  timestamptz,
  orders_count        int not null default 0,
  total_spent         numeric(12,2) not null default 0,
  first_order_at      timestamptz,
  last_order_at       timestamptz,
  tags                text[] not null default '{}',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (store_id, shopify_id)
);
create unique index if not exists customers_store_email_uq on customers (store_id, email) where email is not null;

-- Append-only consent history (legal audit trail)
create table if not exists consent_events (
  id            bigserial primary key,
  store_id      uuid not null references stores(id) on delete cascade,
  customer_id   uuid not null references customers(id) on delete cascade,
  state         text not null,
  source        text not null,                         -- shopify_webhook / backfill / unsubscribe_link / resend_webhook / manual
  occurred_at   timestamptz not null default now(),
  raw           jsonb
);

create table if not exists orders (
  id              uuid primary key default gen_random_uuid(),
  store_id        uuid not null references stores(id) on delete cascade,
  shopify_id      text not null,
  customer_id     uuid references customers(id) on delete set null,
  order_number    text,
  total_price     numeric(12,2) not null default 0,
  currency        text,
  financial_status text,
  processed_at    timestamptz not null,
  cancelled_at    timestamptz,
  created_at      timestamptz not null default now(),
  unique (store_id, shopify_id)
);

create table if not exists order_lines (
  id            bigserial primary key,
  store_id      uuid not null references stores(id) on delete cascade,
  order_id      uuid not null references orders(id) on delete cascade,
  product_id    uuid references products(id) on delete set null,
  shopify_product_id text,
  shopify_variant_id text,
  title         text,
  quantity      int not null default 1,
  price         numeric(12,2) not null default 0
);
create index if not exists order_lines_store_product_idx on order_lines (store_id, product_id);

-- Unified behavioural event stream (orders, checkouts, email engagement, site)
create table if not exists events (
  id            bigserial primary key,
  store_id      uuid not null references stores(id) on delete cascade,
  customer_id   uuid references customers(id) on delete cascade,
  type          text not null,          -- order_placed, checkout_started, checkout_abandoned, product_viewed, email_sent, email_delivered, email_opened, email_clicked, email_bounced, email_complained, unsubscribed
  occurred_at   timestamptz not null default now(),
  product_id    uuid references products(id) on delete set null,
  campaign_id   uuid,
  value         numeric(12,2),
  props         jsonb not null default '{}'::jsonb,
  dedupe_key    text,
  unique (store_id, dedupe_key)
);
create index if not exists events_store_customer_time_idx on events (store_id, customer_id, occurred_at desc);
create index if not exists events_store_type_time_idx on events (store_id, type, occurred_at desc);

-- ---------------------------------------------------------------------------
-- Suppression (hard stops; checked at send time, never bypassable by AI)
-- ---------------------------------------------------------------------------
create table if not exists suppressions (
  id          bigserial primary key,
  store_id    uuid not null references stores(id) on delete cascade,
  email       citext not null,
  reason      text not null,            -- unsubscribed / bounced / complained / manual
  source      text,
  created_at  timestamptz not null default now(),
  unique (store_id, email)
);

-- ---------------------------------------------------------------------------
-- Email content
-- ---------------------------------------------------------------------------
create table if not exists templates (
  id            uuid primary key default gen_random_uuid(),
  store_id      uuid references stores(id) on delete cascade,   -- null = global seed template
  name          text not null,
  kind          text not null default 'custom',                 -- custom / cart_recovery / second_purchase / winback / affinity
  subject       text not null default '',
  preheader     text not null default '',
  content_json  jsonb not null,                                 -- Maily (Tiptap) JSONContent
  preview_html  text,                                           -- cached render with sample data
  variables     text[] not null default '{}',                   -- variable names referenced
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- AI planning → approval → campaign → sends
-- ---------------------------------------------------------------------------
create table if not exists campaign_briefs (
  id              uuid primary key default gen_random_uuid(),
  store_id        uuid not null references stores(id) on delete cascade,
  lifecycle_job   text not null,          -- cart_recovery / second_purchase / winback / affinity / manual
  status          text not null default 'draft'
                    check (status in ('draft','approved','rejected','sent','expired')),
  title           text not null,
  rationale       text not null,          -- "why now, why these people"
  audience_sql    text,                   -- read-only SELECT producing customer_id rows; validated server-side
  audience_count  int,
  product_ids     uuid[] not null default '{}',
  subject         text not null,
  preheader       text not null default '',
  blocks          jsonb not null,         -- AI structured output (see src/lib/ai/brief-schema.ts)
  template_id     uuid references templates(id) on delete set null,
  send_window_start timestamptz,
  send_window_end   timestamptz,
  discount_code   text,
  model           text,
  usage           jsonb,                  -- tokens incl. cache_read/cache_creation for cost tracking
  approved_by     text,                   -- clerk user id
  approved_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists briefs_store_status_idx on campaign_briefs (store_id, status, created_at desc);

create table if not exists campaigns (
  id            uuid primary key default gen_random_uuid(),
  store_id      uuid not null references stores(id) on delete cascade,
  brief_id      uuid references campaign_briefs(id) on delete set null,
  template_id   uuid references templates(id) on delete set null,
  name          text not null,
  subject       text not null,
  preheader     text not null default '',
  status        text not null default 'queued'
                  check (status in ('queued','sending','sent','failed','cancelled')),
  scheduled_for timestamptz,
  started_at    timestamptz,
  finished_at   timestamptz,
  recipients    int not null default 0,
  created_at    timestamptz not null default now()
);

create table if not exists sends (
  id              uuid primary key default gen_random_uuid(),
  store_id        uuid not null references stores(id) on delete cascade,
  campaign_id     uuid not null references campaigns(id) on delete cascade,
  customer_id     uuid not null references customers(id) on delete cascade,
  email           citext not null,
  provider_id     text,                   -- Resend email id
  status          text not null default 'queued'
                    check (status in ('queued','skipped','sent','delivered','bounced','complained','failed')),
  skip_reason     text,                   -- suppressed / not_subscribed / frequency_cap / no_email
  sent_at         timestamptz,
  delivered_at    timestamptz,
  opened_at       timestamptz,
  clicked_at      timestamptz,
  bounced_at      timestamptz,
  complained_at   timestamptz,
  error           text,
  unique (campaign_id, customer_id)
);
create index if not exists sends_store_customer_sent_idx on sends (store_id, customer_id, sent_at desc);
create index if not exists sends_provider_idx on sends (provider_id);

-- Revenue attribution: order within window after a send
create table if not exists attributions (
  id          bigserial primary key,
  store_id    uuid not null references stores(id) on delete cascade,
  send_id     uuid not null references sends(id) on delete cascade,
  order_id    uuid not null references orders(id) on delete cascade,
  campaign_id uuid not null references campaigns(id) on delete cascade,
  amount      numeric(12,2) not null,
  model       text not null default 'last_click_7d',
  created_at  timestamptz not null default now(),
  unique (order_id, model)
);

-- Every customer-facing / AI action, for the approval audit trail
create table if not exists audit_log (
  id          bigserial primary key,
  store_id    uuid not null references stores(id) on delete cascade,
  actor       text not null,              -- clerk user id | 'ai' | 'system'
  action      text not null,              -- brief.created, brief.approved, campaign.sent, template.updated, ...
  entity_type text,
  entity_id   text,
  meta        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists audit_store_time_idx on audit_log (store_id, created_at desc);

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------
create or replace function set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

do $$
declare t text;
begin
  foreach t in array array['stores','products','customers','templates','campaign_briefs']
  loop
    execute format('drop trigger if exists %I_updated_at on %I', t, t);
    execute format('create trigger %I_updated_at before update on %I for each row execute function set_updated_at()', t, t);
  end loop;
end $$;
