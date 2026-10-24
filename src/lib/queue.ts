import { PgBoss, type Db as IDatabase } from "pg-boss";
import { directDatabaseUrl, sql } from "./db";
import { isCloudflareWorker } from "./runtime/cloudflare";

/**
 * pg-boss job names. Keep every queue name here so web + worker agree.
 * Payload types live next to the handlers in src/jobs/*.
 */
export const JOBS = {
  // Shopify
  SHOPIFY_WEBHOOK: "shopify.webhook", // { storeId, topic, shopDomain, payload }
  SHOPIFY_BACKFILL: "shopify.backfill", // { storeId, kinds?: ('products'|'customers'|'orders')[] }
  SHOPIFY_BACKFILL_POLL: "shopify.backfill.poll", // { storeId, bulkOperationId, kind }

  // Email
  CAMPAIGN_SEND: "campaign.send", // { campaignId }  → fans out to CAMPAIGN_SEND_BATCH
  CAMPAIGN_SEND_BATCH: "campaign.send.batch", // { campaignId, sendIds: string[] }
  RESEND_EVENT: "resend.event", // { type, data } raw Resend webhook event

  // Intelligence
  SCORING_NIGHTLY: "scoring.nightly", // { storeId } recompute RFM/affinity
  LIFECYCLE_PLAN: "lifecycle.plan", // { storeId, job: 'cart_recovery'|'second_purchase'|'winback'|'affinity' }
  ATTRIBUTION: "attribution.run", // { storeId }
} as const;

export type JobName = (typeof JOBS)[keyof typeof JOBS];

declare global {
  // eslint-disable-next-line no-var
  var __boss: PgBoss | undefined;
}

let starting: Promise<PgBoss> | undefined;

/**
 * pg-boss database adapter over our postgres.js client. Used on Cloudflare Workers,
 * where there is no long-lived process: the web app only needs to INSERT jobs,
 * never to poll, supervise or run cron. The Railway worker uses pg-boss's own pool.
 */
const sqlAdapter: IDatabase = {
  async executeSql(text: string, values: unknown[] = []) {
    const rows = await sql.unsafe(text, values as never[]);
    return { rows: rows as unknown as unknown[] };
  },
};

/** Lazily started singleton. Web uses it to `send`; worker uses it to `work`. */
export async function getBoss(): Promise<PgBoss> {
  if (globalThis.__boss) return globalThis.__boss;
  if (starting) return starting;
  starting = (async () => {
    const onWorkers = isCloudflareWorker() || process.env.PGBOSS_SEND_ONLY === "1";
    const boss = onWorkers
      ? new PgBoss({ db: sqlAdapter, schema: "pgboss", migrate: false, supervise: false, schedule: false })
      : new PgBoss({ connectionString: directDatabaseUrl(), schema: "pgboss", max: 4 });
    boss.on("error", (err: unknown) => console.error("[pg-boss]", err));
    await boss.start();
    if (!onWorkers) {
      for (const name of Object.values(JOBS)) {
        await boss.createQueue(name).catch(() => undefined); // idempotent; queues are owned by the Node worker
      }
    }
    globalThis.__boss = boss;
    return boss;
  })();
  return starting;
}

export async function enqueue<T extends object>(
  name: JobName,
  data: T,
  opts: { singletonKey?: string; startAfter?: Date | string | number; retryLimit?: number; priority?: number } = {},
) {
  const boss = await getBoss();
  return boss.send(name, data, {
    retryLimit: opts.retryLimit ?? 3,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 2 * 60 * 60,
    ...(opts.singletonKey ? { singletonKey: opts.singletonKey } : {}),
    ...(opts.startAfter !== undefined ? { startAfter: opts.startAfter } : {}),
    ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
  });
}
