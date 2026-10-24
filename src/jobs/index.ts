import type { PgBoss } from "pg-boss";
import { registerShopifyJobs } from "./shopify";
import { registerEmailJobs } from "./email";
import { registerLifecycleJobs } from "./lifecycle";

/**
 * Worker job registry. Each module owns its handlers and registers them here.
 * Owned by the lead; feature modules only export a `register*Jobs(boss)` fn.
 */
export async function registerAllJobs(boss: PgBoss) {
  await registerShopifyJobs(boss);
  await registerEmailJobs(boss);
  await registerLifecycleJobs(boss);
}
