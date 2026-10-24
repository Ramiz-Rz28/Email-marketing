import postgres, { type Sql } from "postgres";
import { env } from "./env";
import { cloudflareEnv } from "./runtime/cloudflare";

/**
 * Single postgres.js client for the process (Next.js server or worker).
 * All tenant queries MUST filter by store_id. Use `forStore(storeId)` to get
 * helpers that make forgetting the filter hard.
 */
declare global {
  // eslint-disable-next-line no-var
  var __sql: Sql | undefined;
}

/** On Cloudflare the Hyperdrive binding supplies a pooled connection string; elsewhere DATABASE_URL. */
function appDatabaseUrl(): string {
  const cf = cloudflareEnv();
  return cf?.HYPERDRIVE?.connectionString ?? env().DATABASE_URL;
}

let instance: Sql | undefined;

/**
 * Lazily created so that on Cloudflare the first query runs inside a request
 * (where the Hyperdrive binding is readable) rather than at module evaluation.
 */
function getSql(): Sql {
  if (instance) return instance;
  if (globalThis.__sql) return (instance = globalThis.__sql);
  instance = postgres(appDatabaseUrl(), {
    max: cloudflareEnv() ? 2 : 10, // Hyperdrive does the real pooling; keep per-isolate connections tiny
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false, // required for Supabase transaction pooler (pgbouncer)
    transform: { undefined: null },
  });
  if (process.env.NODE_ENV !== "production") globalThis.__sql = instance;
  return instance;
}

/** The postgres.js client. Behaves exactly like a real `Sql` (tagged template + helpers); created on first use. */
export const sql: Sql = new Proxy(function sqlProxy() {} as unknown as Sql, {
  apply: (_target, thisArg, args) => Reflect.apply(getSql() as unknown as (...a: unknown[]) => unknown, thisArg, args),
  get: (_target, prop) => {
    const real = getSql() as unknown as Record<PropertyKey, unknown>;
    const value = real[prop];
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(real) : value;
  },
});

/** Direct (non-pooled) connection string for pg-boss and migrations. */
export function directDatabaseUrl(): string {
  return env().DATABASE_DIRECT_URL ?? env().DATABASE_URL;
}

export type StoreRow = {
  id: string;
  clerk_org_id: string;
  name: string;
  brand_logo_url: string | null;
  brand_primary: string | null;
  brand_font: string | null;
  from_name: string | null;
  from_email: string | null;
  reply_to: string | null;
  timezone: string;
  max_emails_per_customer_per_week: number;
};

export async function getStoreByOrg(clerkOrgId: string): Promise<StoreRow | null> {
  const rows = await sql<StoreRow[]>`select * from stores where clerk_org_id = ${clerkOrgId} limit 1`;
  return rows[0] ?? null;
}

export async function getStoreById(id: string): Promise<StoreRow | null> {
  const rows = await sql<StoreRow[]>`select * from stores where id = ${id} limit 1`;
  return rows[0] ?? null;
}

export async function upsertStoreForOrg(clerkOrgId: string, name: string): Promise<StoreRow> {
  const rows = await sql<StoreRow[]>`
    insert into stores (clerk_org_id, name) values (${clerkOrgId}, ${name})
    on conflict (clerk_org_id) do update set name = excluded.name
    returning *`;
  return rows[0];
}

export async function audit(
  storeId: string,
  actor: string,
  action: string,
  entity?: { type: string; id: string },
  meta: Record<string, unknown> = {},
) {
  await sql`insert into audit_log (store_id, actor, action, entity_type, entity_id, meta)
    values (${storeId}, ${actor}, ${action}, ${entity?.type ?? null}, ${entity?.id ?? null}, ${sql.json(meta as never)})`;
}

/**
 * Validates that an AI/user-provided audience query is a single read-only SELECT
 * that references store_id. Executed with a statement timeout in a read-only tx.
 * Returns customer ids.
 */
export async function runAudienceQuery(storeId: string, audienceSql: string, limit = 50_000): Promise<string[]> {
  const q = audienceSql.trim().replace(/;+$/, "");
  if (!/^select\s/i.test(q)) throw new Error("audience_sql must be a SELECT");
  if (/\b(insert|update|delete|drop|alter|truncate|grant|create|copy)\b/i.test(q)) {
    throw new Error("audience_sql contains a forbidden keyword");
  }
  if (!/store_id/i.test(q)) throw new Error("audience_sql must filter by store_id");
  const wrapped = `select c.id from (${q}) a join customers c on c.id = a.customer_id
                   where c.store_id = $1 and c.marketing_state = 'subscribed' and c.email is not null limit ${limit}`;
  const rows = await sql.begin("read only", async (tx) => {
    await tx.unsafe("set local statement_timeout = '15s'");
    return tx.unsafe<{ id: string }[]>(wrapped, [storeId]);
  });
  return rows.map((r) => r.id);
}
