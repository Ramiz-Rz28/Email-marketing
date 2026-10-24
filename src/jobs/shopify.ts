import type { PgBoss } from "pg-boss";
import type { Sql } from "postgres";
import { sql, audit } from "../lib/db";
import { JOBS, enqueue } from "../lib/queue";
import { downloadJsonl, pollBulkOperation, startBulkQuery, type BulkKind, type JsonlRow, type ShopifyConn } from "../lib/shopify/bulk";
import {
  recomputeCustomerStats,
  recordCheckout,
  upsertCustomer,
  upsertOrder,
  upsertProduct,
} from "../lib/shopify/sync";

type Json = Record<string, unknown>;

export type ShopifyWebhookJob = {
  storeId: string;
  topic: string; // header form, e.g. "orders/create"
  shopDomain: string;
  payload: Json;
};
export type ShopifyBackfillJob = { storeId: string; kinds?: BulkKind[] };
export type ShopifyBackfillPollJob = { storeId: string; bulkOperationId: string; kind: BulkKind };

const ALL_KINDS: BulkKind[] = ["products", "customers", "orders"];
const CHUNK = 500;
const GID_PREFIX: Record<BulkKind, string> = {
  products: "gid://shopify/Product/",
  customers: "gid://shopify/Customer/",
  orders: "gid://shopify/Order/",
};

type ConnRow = ShopifyConn & { uninstalled_at: Date | null };

async function getConn(storeId: string): Promise<ConnRow | null> {
  const rows = await sql<ConnRow[]>`
    select shop_domain, access_token, scopes, uninstalled_at
    from shopify_connections where store_id = ${storeId} limit 1`;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------
async function handleWebhook(job: ShopifyWebhookJob) {
  const { storeId, payload } = job;
  const topic = job.topic.toLowerCase();

  if (topic === "app/uninstalled") {
    await sql`
      update shopify_connections set uninstalled_at = now()
      where store_id = ${storeId} and shop_domain = ${job.shopDomain}`;
    await audit(storeId, "system", "shopify.uninstalled", undefined, { shop: job.shopDomain });
    return;
  }

  // Ignore anything that arrives for a disconnected store.
  const conn = await getConn(storeId);
  if (!conn || conn.uninstalled_at) return;

  switch (topic) {
    case "orders/create":
    case "orders/updated":
      await upsertOrder(storeId, payload);
      break;
    case "customers/create":
    case "customers/update":
      await upsertCustomer(storeId, payload, "shopify_webhook");
      break;
    case "customers/marketing_consent_update": {
      // Payload is either the customer itself or { customer: {...} }; accept both.
      const inner = payload.customer;
      const c = typeof inner === "object" && inner !== null ? { ...payload, ...(inner as Json) } : payload;
      await upsertCustomer(storeId, c, "shopify_webhook");
      break;
    }
    case "checkouts/create":
    case "checkouts/update":
      await recordCheckout(storeId, payload);
      break;
    case "products/create":
    case "products/update":
      await upsertProduct(storeId, payload);
      break;
    default:
      console.warn(`[shopify] unhandled webhook topic ${job.topic}`);
  }
}

// ---------------------------------------------------------------------------
// Backfill
// ---------------------------------------------------------------------------
async function handleBackfill(job: ShopifyBackfillJob) {
  const conn = await getConn(job.storeId);
  if (!conn || conn.uninstalled_at) return;

  const kinds = job.kinds?.length ? job.kinds : ALL_KINDS;
  const errors: string[] = [];
  let started = 0;
  for (const kind of kinds) {
    try {
      const op = await startBulkQuery(conn, kind);
      await enqueue<ShopifyBackfillPollJob>(
        JOBS.SHOPIFY_BACKFILL_POLL,
        { storeId: job.storeId, bulkOperationId: op.id, kind },
        { startAfter: 20 },
      );
      started++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[shopify] backfill ${kind} failed to start: ${msg}`);
      errors.push(`${kind}: ${msg}`);
    }
  }
  if (started === 0) throw new Error(`No bulk operation could be started: ${errors.join(" | ")}`);
  await audit(job.storeId, "system", "shopify.backfill_started", undefined, { kinds, errors });
}

/** Link order lines to products that were imported after the order. */
async function relinkOrderLines(storeId: string) {
  await sql`
    update order_lines ol set product_id = p.id
    from products p
    where ol.store_id = ${storeId} and ol.product_id is null and ol.shopify_product_id is not null
      and p.store_id = ${storeId} and p.shopify_id = ol.shopify_product_id`;
}

async function flushChunk(storeId: string, kind: BulkKind, rows: JsonlRow[]) {
  await sql.begin(async (txn) => {
    const tx = txn as unknown as Sql; // TransactionSql is not structurally assignable to Sql in postgres.js types
    if (kind === "products") {
      for (const r of rows) await upsertProduct(storeId, r, tx);
    } else if (kind === "customers") {
      for (const r of rows) await upsertCustomer(storeId, r, "backfill", tx);
    } else {
      const touched = new Set<string>();
      for (const r of rows) {
        const res = await upsertOrder(storeId, r, { db: tx, skipStats: true });
        if (res?.customerId) touched.add(res.customerId);
      }
      await recomputeCustomerStats(storeId, [...touched], tx);
    }
  });
}

async function ingest(storeId: string, kind: BulkKind, url: string): Promise<number> {
  const prefix = GID_PREFIX[kind];
  let chunk: JsonlRow[] = [];
  let total = 0;
  for await (const row of downloadJsonl(url)) {
    if (typeof row.id !== "string" || !row.id.startsWith(prefix)) continue; // orphan child rows
    chunk.push(row);
    if (chunk.length >= CHUNK) {
      await flushChunk(storeId, kind, chunk);
      total += chunk.length;
      chunk = [];
    }
  }
  if (chunk.length) {
    await flushChunk(storeId, kind, chunk);
    total += chunk.length;
  }
  return total;
}

async function handleBackfillPoll(job: ShopifyBackfillPollJob) {
  const { storeId, bulkOperationId, kind } = job;
  const conn = await getConn(storeId);
  if (!conn || conn.uninstalled_at) return;

  const op = await pollBulkOperation(conn, bulkOperationId);

  if (op.status === "CREATED" || op.status === "RUNNING" || op.status === "CANCELING") {
    await enqueue<ShopifyBackfillPollJob>(JOBS.SHOPIFY_BACKFILL_POLL, job, { startAfter: 30 });
    return;
  }

  if (op.status !== "COMPLETED") {
    console.error(`[shopify] bulk ${kind} ${bulkOperationId} ended ${op.status} (${op.errorCode ?? "no code"})`);
    await audit(storeId, "system", "shopify.backfill_failed", undefined, {
      kind,
      status: op.status,
      errorCode: op.errorCode,
    });
    return;
  }

  let imported = 0;
  if (op.url) imported = await ingest(storeId, kind, op.url); // url is null when the export is empty

  if (kind === "products" || kind === "orders") await relinkOrderLines(storeId);

  if (kind === "orders") {
    await sql`update shopify_connections set last_backfill_at = now() where store_id = ${storeId}`;
  }
  await audit(storeId, "system", "shopify.backfill_completed", undefined, { kind, imported });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------
export async function registerShopifyJobs(boss: PgBoss) {
  await boss.work<ShopifyWebhookJob>(JOBS.SHOPIFY_WEBHOOK, { batchSize: 1 }, async ([job]) => {
    await handleWebhook(job.data);
  });

  await boss.work<ShopifyBackfillJob>(JOBS.SHOPIFY_BACKFILL, { batchSize: 1 }, async ([job]) => {
    await handleBackfill(job.data);
  });

  await boss.work<ShopifyBackfillPollJob>(JOBS.SHOPIFY_BACKFILL_POLL, { batchSize: 1 }, async ([job]) => {
    await handleBackfillPoll(job.data);
  });

  console.log("[jobs] shopify: handlers registered");
}
