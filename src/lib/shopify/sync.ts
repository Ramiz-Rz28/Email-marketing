import type { Sql } from "postgres";
import { sql } from "../db";

/**
 * Idempotent upserts shared by webhooks (REST-style JSON: numeric ids, snake_case)
 * and bulk backfill (GraphQL JSONL: gid ids, camelCase). Every function accepts an
 * optional `db` so callers can run a chunk inside one transaction.
 * Every query is scoped by store_id.
 */

type Json = Record<string, unknown>;
type Db = Sql;

export type ConsentSource = "shopify_webhook" | "backfill" | "manual";
export type MarketingState = "subscribed" | "not_subscribed" | "unsubscribed" | "pending" | "invalid";

// ---------------------------------------------------------------------------
// tiny coercion helpers
// ---------------------------------------------------------------------------
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const obj = (v: unknown): Json => (isObj(v) ? v : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function str(v: unknown): string | null {
  if (typeof v === "string") return v.length ? v : null;
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  return null;
}

/** Money / decimal as a string Postgres will accept, or null. */
function money(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return v.trim();
  return null;
}

function int(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function isoDate(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** 123 or "123" → gid://shopify/<Kind>/123; gids pass through. */
export function toGid(kind: string, id: unknown): string | null {
  const s = str(id);
  if (!s) return null;
  return s.startsWith("gid://") ? s : `gid://shopify/${kind}/${s}`;
}

function tagList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean);
  if (typeof v === "string") return v.split(",").map((t) => t.trim()).filter(Boolean);
  return [];
}

function lowerEmail(v: unknown): string | null {
  const s = str(v);
  return s ? s.trim().toLowerCase() : null;
}

const MARKETING_STATES: Record<string, MarketingState> = {
  subscribed: "subscribed",
  not_subscribed: "not_subscribed",
  unsubscribed: "unsubscribed",
  pending: "pending",
  invalid: "invalid",
  // legacy REST values
  redacted: "unsubscribed",
};

function marketingState(v: unknown): MarketingState | null {
  const s = str(v);
  if (!s) return null;
  return MARKETING_STATES[s.toLowerCase()] ?? null;
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------
export type NormalizedProduct = {
  shopifyId: string;
  handle: string | null;
  title: string;
  productType: string | null;
  vendor: string | null;
  tags: string[];
  imageUrl: string | null;
  url: string | null;
  priceMin: string | null;
  priceMax: string | null;
  status: string | null;
};

export function normalizeProduct(p: Json): NormalizedProduct | null {
  const shopifyId = toGid("Product", p.id);
  if (!shopifyId) return null;

  // price range: GraphQL priceRangeV2, or REST variants[].price
  let priceMin = money(obj(obj(p.priceRangeV2).minVariantPrice).amount);
  let priceMax = money(obj(obj(p.priceRangeV2).maxVariantPrice).amount);
  if (priceMin === null || priceMax === null) {
    const prices = arr(p.variants)
      .map((v) => money(obj(v).price))
      .filter((x): x is string => x !== null)
      .map(Number);
    if (prices.length) {
      priceMin = String(Math.min(...prices));
      priceMax = String(Math.max(...prices));
    }
  }

  const image =
    str(obj(p.featuredImage).url) ?? str(obj(p.image).src) ?? str(obj(arr(p.images)[0]).src) ?? null;

  return {
    shopifyId,
    handle: str(p.handle),
    title: str(p.title) ?? "(untitled)",
    productType: str(p.productType) ?? str(p.product_type),
    vendor: str(p.vendor),
    tags: tagList(p.tags),
    imageUrl: image,
    url: str(p.onlineStoreUrl),
    priceMin,
    priceMax,
    status: str(p.status)?.toUpperCase() ?? null,
  };
}

/** Upsert a product; returns our uuid (or null if the payload had no id). */
export async function upsertProduct(storeId: string, p: Json, db: Db = sql): Promise<string | null> {
  const n = normalizeProduct(p);
  if (!n) return null;
  const rows = await db<{ id: string }[]>`
    insert into products (store_id, shopify_id, handle, title, product_type, vendor, tags, image_url, url, price_min, price_max, status)
    values (${storeId}, ${n.shopifyId}, ${n.handle}, ${n.title}, ${n.productType}, ${n.vendor},
            ${db.array(n.tags)}::text[], ${n.imageUrl}, ${n.url}, ${n.priceMin}, ${n.priceMax}, ${n.status})
    on conflict (store_id, shopify_id) do update set
      handle       = coalesce(excluded.handle, products.handle),
      title        = excluded.title,
      product_type = excluded.product_type,
      vendor       = excluded.vendor,
      tags         = excluded.tags,
      image_url    = coalesce(excluded.image_url, products.image_url),
      url          = coalesce(excluded.url, products.url),
      price_min    = coalesce(excluded.price_min, products.price_min),
      price_max    = coalesce(excluded.price_max, products.price_max),
      status       = coalesce(excluded.status, products.status)
    returning id`;
  return rows[0]?.id ?? null;
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------
export type NormalizedCustomer = {
  shopifyId: string | null;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  /** null = payload carried no consent info → leave existing state untouched */
  state: MarketingState | null;
  optInLevel: string | null;
  consentUpdatedAt: string | null;
  consentRaw: Json | null;
  ordersCount: number | null;
  totalSpent: string | null;
  tags: string[] | null;
  createdAt: string | null;
};

export function normalizeCustomer(c: Json): NormalizedCustomer {
  // Consent can arrive as REST email_marketing_consent, GraphQL emailMarketingConsent (deprecated)
  // or GraphQL defaultEmailAddress { marketingState ... }.
  const restConsent = obj(c.email_marketing_consent);
  const gqlConsent = obj(c.emailMarketingConsent);
  const defaultAddr = obj(c.defaultEmailAddress);

  const rawState = restConsent.state ?? gqlConsent.marketingState ?? defaultAddr.marketingState;
  const consentRaw = isObj(c.email_marketing_consent)
    ? restConsent
    : isObj(c.emailMarketingConsent)
      ? gqlConsent
      : isObj(c.defaultEmailAddress)
        ? defaultAddr
        : null;

  const email =
    lowerEmail(c.email) ?? lowerEmail(c.email_address) ?? lowerEmail(defaultAddr.emailAddress);

  const spent = c.amountSpent !== undefined ? obj(c.amountSpent).amount : c.total_spent;

  return {
    shopifyId: toGid("Customer", c.id ?? c.customer_id),
    email,
    firstName: str(c.firstName) ?? str(c.first_name),
    lastName: str(c.lastName) ?? str(c.last_name),
    state: marketingState(rawState),
    optInLevel:
      str(restConsent.opt_in_level) ??
      str(gqlConsent.marketingOptInLevel) ??
      str(defaultAddr.marketingOptInLevel),
    consentUpdatedAt:
      isoDate(restConsent.consent_updated_at) ??
      isoDate(gqlConsent.consentUpdatedAt) ??
      isoDate(defaultAddr.marketingUpdatedAt),
    consentRaw,
    ordersCount: int(c.numberOfOrders ?? c.orders_count),
    totalSpent: money(spent),
    tags: c.tags === undefined ? null : tagList(c.tags),
    createdAt: isoDate(c.createdAt ?? c.created_at),
  };
}

type CustomerLookup = { shopifyId: string | null; email: string | null };

async function findCustomer(
  storeId: string,
  who: CustomerLookup,
  db: Db,
): Promise<{ id: string; shopify_id: string | null; marketing_state: MarketingState } | null> {
  type Row = { id: string; shopify_id: string | null; marketing_state: MarketingState };
  if (who.shopifyId) {
    const rows = await db<Row[]>`
      select id, shopify_id, marketing_state from customers
      where store_id = ${storeId} and shopify_id = ${who.shopifyId} limit 1`;
    if (rows[0]) return rows[0];
  }
  if (who.email) {
    const rows = await db<Row[]>`
      select id, shopify_id, marketing_state from customers
      where store_id = ${storeId} and email = ${who.email} limit 1`;
    if (rows[0]) return rows[0];
  }
  return null;
}

/**
 * Upsert a customer and keep the consent trail. Returns our uuid, or null when
 * the payload has neither a Shopify id nor an email (nothing to key on).
 */
export async function upsertCustomer(
  storeId: string,
  c: Json,
  source: ConsentSource = "shopify_webhook",
  db: Db = sql,
): Promise<string | null> {
  const n = normalizeCustomer(c);
  if (!n.shopifyId && !n.email) return null;

  const existing = await findCustomer(storeId, n, db);
  let customerId: string;
  let previousState: MarketingState | null = null;

  if (existing) {
    customerId = existing.id;
    previousState = existing.marketing_state;
    await db`
      update customers set
        shopify_id             = coalesce(shopify_id, ${n.shopifyId}),
        email                  = coalesce(${n.email}, email),
        first_name             = coalesce(${n.firstName}, first_name),
        last_name              = coalesce(${n.lastName}, last_name),
        marketing_state        = ${n.state ?? existing.marketing_state},
        marketing_opt_in_level = coalesce(${n.optInLevel}, marketing_opt_in_level),
        consent_updated_at     = coalesce(${n.consentUpdatedAt}, consent_updated_at),
        tags                   = coalesce(${n.tags ? db.array(n.tags) : null}::text[], tags)
      where id = ${customerId} and store_id = ${storeId}`;
  } else {
    const rows = await db<{ id: string }[]>`
      insert into customers (store_id, shopify_id, email, first_name, last_name, marketing_state,
                             marketing_opt_in_level, consent_updated_at, orders_count, total_spent, tags, created_at)
      values (${storeId}, ${n.shopifyId}, ${n.email}, ${n.firstName}, ${n.lastName},
              ${n.state ?? "not_subscribed"}, ${n.optInLevel}, ${n.consentUpdatedAt},
              ${n.ordersCount ?? 0}, ${n.totalSpent ?? "0"}, ${db.array(n.tags ?? [])}::text[],
              coalesce(${n.createdAt}::timestamptz, now()))
      returning id`;
    customerId = rows[0].id;
  }

  // Consent history: only when the payload actually carried a state and it changed (or is new).
  if (n.state && n.state !== previousState) {
    await db`
      insert into consent_events (store_id, customer_id, state, source, occurred_at, raw)
      values (${storeId}, ${customerId}, ${n.state}, ${source},
              coalesce(${n.consentUpdatedAt}::timestamptz, now()),
              ${n.consentRaw ? db.json(n.consentRaw as never) : null})`;
  }
  return customerId;
}

/**
 * Resolve (and optionally create a minimal, non-subscribed) customer for an order/checkout.
 * Never changes marketing state of an existing customer.
 */
async function resolveCustomerId(
  storeId: string,
  who: { shopifyId: string | null; email: string | null; firstName?: string | null; lastName?: string | null },
  create: boolean,
  db: Db,
): Promise<string | null> {
  if (!who.shopifyId && !who.email) return null;
  const existing = await findCustomer(storeId, who, db);
  if (existing) {
    if (!existing.shopify_id && who.shopifyId) {
      await db`update customers set shopify_id = ${who.shopifyId} where id = ${existing.id} and store_id = ${storeId}`;
    }
    return existing.id;
  }
  if (!create) return null;
  const rows = await db<{ id: string }[]>`
    insert into customers (store_id, shopify_id, email, first_name, last_name)
    values (${storeId}, ${who.shopifyId}, ${who.email}, ${who.firstName ?? null}, ${who.lastName ?? null})
    returning id`;
  return rows[0].id;
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------
type NormalizedLine = {
  shopifyProductId: string | null;
  shopifyVariantId: string | null;
  title: string | null;
  quantity: number;
  price: string;
};

type NormalizedOrder = {
  shopifyId: string;
  orderNumber: string | null;
  totalPrice: string;
  currency: string | null;
  financialStatus: string | null;
  processedAt: string;
  cancelledAt: string | null;
  customer: { shopifyId: string | null; email: string | null; firstName: string | null; lastName: string | null };
  lines: NormalizedLine[];
};

export function normalizeOrder(o: Json): NormalizedOrder | null {
  const shopifyId = toGid("Order", o.id);
  if (!shopifyId) return null;

  const total = obj(obj(o.totalPriceSet).shopMoney);
  const cust = obj(o.customer);

  const rawLines = arr(o.lineItems).length ? arr(o.lineItems) : arr(o.line_items).length ? arr(o.line_items) : arr(o.__children);
  const lines: NormalizedLine[] = rawLines.map((raw) => {
    const li = obj(raw);
    return {
      shopifyProductId: toGid("Product", obj(li.product).id ?? li.product_id),
      shopifyVariantId: toGid("ProductVariant", obj(li.variant).id ?? li.variant_id),
      title: str(li.title) ?? str(li.name),
      quantity: int(li.quantity) ?? 1,
      price: money(obj(obj(li.originalUnitPriceSet).shopMoney).amount) ?? money(li.price) ?? "0",
    };
  });

  return {
    shopifyId,
    orderNumber: str(o.order_number) ?? str(o.name),
    totalPrice: money(total.amount) ?? money(o.total_price) ?? "0",
    currency: str(total.currencyCode) ?? str(o.currencyCode) ?? str(o.currency),
    financialStatus: (str(o.displayFinancialStatus) ?? str(o.financial_status))?.toLowerCase() ?? null,
    processedAt: isoDate(o.processedAt ?? o.processed_at) ?? isoDate(o.createdAt ?? o.created_at) ?? new Date().toISOString(),
    cancelledAt: isoDate(o.cancelledAt ?? o.cancelled_at),
    customer: {
      shopifyId: toGid("Customer", cust.id),
      email: lowerEmail(cust.email) ?? lowerEmail(o.email) ?? lowerEmail(o.contact_email),
      firstName: str(cust.firstName) ?? str(cust.first_name),
      lastName: str(cust.lastName) ?? str(cust.last_name),
    },
    lines,
  };
}

/** Recompute denormalised order stats for the given customers from the orders table. */
export async function recomputeCustomerStats(storeId: string, customerIds: string[], db: Db = sql) {
  if (!customerIds.length) return;
  await db`
    update customers c set
      orders_count   = coalesce(a.cnt, 0),
      total_spent    = coalesce(a.total, 0),
      first_order_at = a.first_at,
      last_order_at  = a.last_at
    from (
      select ids.id as customer_id, o.cnt, o.total, o.first_at, o.last_at
      from unnest(${db.array(customerIds)}::uuid[]) as ids(id)
      left join (
        select customer_id, count(*)::int as cnt, sum(total_price) as total,
               min(processed_at) as first_at, max(processed_at) as last_at
        from orders
        where store_id = ${storeId} and cancelled_at is null and customer_id is not null
        group by customer_id
      ) o on o.customer_id = ids.id
    ) a
    where c.id = a.customer_id and c.store_id = ${storeId}`;
}

/**
 * Upsert an order with its lines and an `order_placed` event, then refresh the
 * customer's aggregates (skip with opts.skipStats and call recomputeCustomerStats yourself).
 */
export async function upsertOrder(
  storeId: string,
  o: Json,
  opts: { db?: Db; skipStats?: boolean } = {},
): Promise<{ orderId: string; customerId: string | null } | null> {
  const db = opts.db ?? sql;
  const n = normalizeOrder(o);
  if (!n) return null;

  const customerId = await resolveCustomerId(storeId, n.customer, true, db);

  const rows = await db<{ id: string; customer_id: string | null }[]>`
    insert into orders (store_id, shopify_id, customer_id, order_number, total_price, currency, financial_status, processed_at, cancelled_at)
    values (${storeId}, ${n.shopifyId}, ${customerId}, ${n.orderNumber}, ${n.totalPrice}, ${n.currency},
            ${n.financialStatus}, ${n.processedAt}, ${n.cancelledAt})
    on conflict (store_id, shopify_id) do update set
      customer_id      = coalesce(excluded.customer_id, orders.customer_id),
      order_number     = coalesce(excluded.order_number, orders.order_number),
      total_price      = excluded.total_price,
      currency         = coalesce(excluded.currency, orders.currency),
      financial_status = excluded.financial_status,
      processed_at     = excluded.processed_at,
      cancelled_at     = excluded.cancelled_at
    returning id, customer_id`;
  const orderId = rows[0].id;
  const finalCustomerId = customerId ?? rows[0].customer_id;

  // Lines: replace wholesale (order edits can add/remove lines).
  if (n.lines.length) {
    const productGids = [...new Set(n.lines.map((l) => l.shopifyProductId).filter((x): x is string => !!x))];
    const productMap = new Map<string, string>();
    if (productGids.length) {
      const prods = await db<{ id: string; shopify_id: string }[]>`
        select id, shopify_id from products
        where store_id = ${storeId} and shopify_id = any(${db.array(productGids)}::text[])`;
      for (const p of prods) productMap.set(p.shopify_id, p.id);
    }
    await db`delete from order_lines where order_id = ${orderId} and store_id = ${storeId}`;
    const lineRows = n.lines.map((l) => ({
      store_id: storeId,
      order_id: orderId,
      product_id: l.shopifyProductId ? (productMap.get(l.shopifyProductId) ?? null) : null,
      shopify_product_id: l.shopifyProductId,
      shopify_variant_id: l.shopifyVariantId,
      title: l.title,
      quantity: l.quantity,
      price: l.price,
    }));
    await db`insert into order_lines ${db(
      lineRows,
      "store_id",
      "order_id",
      "product_id",
      "shopify_product_id",
      "shopify_variant_id",
      "title",
      "quantity",
      "price",
    )}`;
  } else {
    await db`delete from order_lines where order_id = ${orderId} and store_id = ${storeId}`;
  }

  // Event stream
  await db`
    insert into events (store_id, customer_id, type, occurred_at, value, props, dedupe_key)
    values (${storeId}, ${finalCustomerId}, 'order_placed', ${n.processedAt}, ${n.totalPrice},
            ${db.json({
              order_id: orderId,
              shopify_order_id: n.shopifyId,
              order_number: n.orderNumber,
              financial_status: n.financialStatus,
              cancelled: n.cancelledAt !== null,
              line_count: n.lines.length,
            } as never)},
            ${`order:${n.shopifyId}`})
    on conflict (store_id, dedupe_key) do update set
      customer_id = coalesce(excluded.customer_id, events.customer_id),
      value       = excluded.value,
      props       = excluded.props`;

  if (finalCustomerId && !opts.skipStats) {
    await recomputeCustomerStats(storeId, [finalCustomerId], db);
  }
  return { orderId, customerId: finalCustomerId };
}

// ---------------------------------------------------------------------------
// Checkouts
// ---------------------------------------------------------------------------
/** Record/refresh a `checkout_started` event from a checkouts/create|update payload. */
export async function recordCheckout(storeId: string, c: Json, db: Db = sql): Promise<string | null> {
  const token = str(c.token) ?? str(c.cart_token) ?? str(c.id);
  if (!token) return null;

  const cust = obj(c.customer);
  const email = lowerEmail(c.email) ?? lowerEmail(cust.email);
  const customerId = await resolveCustomerId(
    storeId,
    { shopifyId: toGid("Customer", cust.id), email },
    false,
    db,
  );

  const items = arr(c.line_items).map((raw) => {
    const li = obj(raw);
    return {
      product_id: toGid("Product", li.product_id),
      variant_id: toGid("ProductVariant", li.variant_id),
      title: str(li.title),
      quantity: int(li.quantity) ?? 1,
      price: money(li.price),
    };
  });

  const total = money(c.total_price) ?? money(c.subtotal_price);
  const occurredAt = isoDate(c.created_at) ?? new Date().toISOString();
  const props = {
    checkout_token: token,
    abandoned_checkout_url: str(c.abandoned_checkout_url),
    currency: str(c.currency),
    completed_at: isoDate(c.completed_at),
    line_items: items,
    email_present: email !== null,
  };

  const rows = await db<{ id: string }[]>`
    insert into events (store_id, customer_id, type, occurred_at, value, props, dedupe_key)
    values (${storeId}, ${customerId}, 'checkout_started', ${occurredAt}, ${total},
            ${db.json(props as never)}, ${`checkout:${token}:started`})
    on conflict (store_id, dedupe_key) do update set
      customer_id = coalesce(excluded.customer_id, events.customer_id),
      value       = coalesce(excluded.value, events.value),
      props       = excluded.props
    returning id`;
  return rows[0]?.id ?? null;
}
