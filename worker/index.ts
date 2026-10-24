import "dotenv/config";
import { getBoss, JOBS } from "../src/lib/queue";
import { registerAllJobs } from "../src/jobs";
import { sql } from "../src/lib/db";

/**
 * Railway service #2: long-running Node worker.
 * - registers all pg-boss handlers
 * - schedules recurring jobs (per store) via pg-boss cron
 */
async function main() {
  const boss = await getBoss();
  await registerAllJobs(boss);

  // Nightly scoring + lifecycle planning for every connected store.
  // Scheduler job fans out per-store jobs so one slow store can't block others.
  await boss.createQueue("scheduler.nightly").catch(() => undefined);
  await boss.schedule("scheduler.nightly", "0 3 * * *", {}, { tz: "America/Toronto" });
  await boss.work("scheduler.nightly", async () => {
    const stores = await sql<{ id: string }[]>`
      select s.id from stores s join shopify_connections c on c.store_id = s.id where c.uninstalled_at is null`;
    for (const s of stores) {
      await boss.send(JOBS.SCORING_NIGHTLY, { storeId: s.id }, { singletonKey: `scoring:${s.id}` });
      await boss.send(JOBS.ATTRIBUTION, { storeId: s.id }, { singletonKey: `attr:${s.id}` });
    }
    console.log(`[scheduler] queued nightly scoring for ${stores.length} store(s)`);
  });

  console.log("[worker] ready");
  const shutdown = async () => {
    console.log("[worker] shutting down");
    await boss.stop({ graceful: true, timeout: 30_000 });
    await sql.end({ timeout: 5 });
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
