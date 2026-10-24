import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

/**
 * Minimal forward-only migration runner over supabase/migrations/*.sql.
 * Used on Railway (no Supabase CLI there). Idempotent via schema_migrations.
 */
async function main() {
  const url = process.env.DATABASE_DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL missing");
  const sql = postgres(url, { max: 1, prepare: false });
  await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz default now())`;
  const applied = new Set((await sql<{ name: string }[]>`select name from schema_migrations`).map((r) => r.name));
  const dir = join(process.cwd(), "supabase", "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    if (applied.has(f)) continue;
    const body = readFileSync(join(dir, f), "utf8");
    console.log(`applying ${f}`);
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into schema_migrations (name) values (${f})`;
    });
  }
  await sql.end();
  console.log(`done (${files.length} total, ${files.length - applied.size} applied now)`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
