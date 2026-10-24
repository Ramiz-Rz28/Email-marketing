import type { PgBoss } from "pg-boss";
import { audit, sql } from "../lib/db";
import { enqueue, JOBS } from "../lib/queue";
import { generateBrief } from "../lib/ai/briefs";
import { createTemplateFromBrief } from "../lib/ai/brief-to-maily";
import {
  LIFECYCLE_BUILDERS,
  LIFECYCLE_JOBS,
  invalidateStoreDigest,
  isLifecycleJob,
} from "../lib/lifecycle/jobs";

type StorePayload = { storeId: string };
type PlanPayload = StorePayload & { job: string; force?: boolean };

const MIN_AUDIENCE = 5;

/**
 * Intelligence jobs: nightly scoring, lifecycle planning (AI briefs), revenue attribution.
 * pg-boss v12 handlers receive an array of jobs; batchSize 1 means exactly one element.
 */
export async function registerLifecycleJobs(boss: PgBoss) {
  await boss.work<StorePayload>(JOBS.SCORING_NIGHTLY, { batchSize: 1 }, async ([job]) => {
    if (!job) return;
    const { storeId } = job.data;

    const [scored] = await sql<{ n: number }[]>`select refresh_customer_scores(${storeId}::uuid) as n`;
    const [pairs] = await sql<{ n: number }[]>`select refresh_product_cooccurrence(${storeId}::uuid) as n`;
    invalidateStoreDigest(storeId);
    console.log(`[scoring] store=${storeId} customers=${scored?.n ?? 0} cooccurrence_pairs=${pairs?.n ?? 0}`);

    for (const lifecycleJob of LIFECYCLE_JOBS) {
      await enqueue(JOBS.LIFECYCLE_PLAN, { storeId, job: lifecycleJob }, { singletonKey: `plan:${storeId}:${lifecycleJob}` });
    }
  });

  await boss.work<PlanPayload>(JOBS.LIFECYCLE_PLAN, { batchSize: 1 }, async ([job]) => {
    if (!job) return;
    const { storeId, job: lifecycleJob, force } = job.data;
    if (!isLifecycleJob(lifecycleJob)) throw new Error(`unknown lifecycle job: ${String(lifecycleJob)}`);

    if (!force) {
      const recent = await sql<{ id: string }[]>`
        select id from campaign_briefs
        where store_id = ${storeId} and lifecycle_job = ${lifecycleJob} and status = 'draft'
          and created_at > now() - interval '24 hours'
        limit 1`;
      if (recent.length > 0) {
        console.log(`[lifecycle] store=${storeId} job=${lifecycleJob} skipped: recent draft ${recent[0].id}`);
        return;
      }
    }

    const candidate = await LIFECYCLE_BUILDERS[lifecycleJob](storeId);
    if (candidate.stats.count < MIN_AUDIENCE) {
      await audit(storeId, "system", "brief.skipped", undefined, {
        job: lifecycleJob,
        reason: "audience_too_small",
        audience_count: candidate.stats.count,
        minimum: MIN_AUDIENCE,
      });
      return;
    }

    const brief = await generateBrief({
      storeId,
      job: lifecycleJob,
      audienceSql: candidate.audienceSql,
      stats: candidate.stats,
      productIds: candidate.productIds,
      defaultDiscount: candidate.defaultDiscount,
    });
    await createTemplateFromBrief(brief.id, { storeId });
  });

  await boss.work<StorePayload>(JOBS.ATTRIBUTION, { batchSize: 1 }, async ([job]) => {
    if (!job) return;
    const { storeId } = job.data;

    // Last-click within 7 days before the order: prefer the latest clicked send, otherwise the
    // latest opened send. Orders already attributed (unique order_id + model) are left alone.
    const inserted = await sql<{ id: string }[]>`
      insert into attributions (store_id, send_id, order_id, campaign_id, amount, model)
      select o.store_id, hit.id, o.id, hit.campaign_id, o.total_price, 'last_click_7d'
      from orders o
      join lateral (
        select sd.id, sd.campaign_id
        from sends sd
        where sd.store_id = o.store_id
          and sd.customer_id = o.customer_id
          and coalesce(sd.clicked_at, sd.opened_at) is not null
          and coalesce(sd.clicked_at, sd.opened_at) <= o.processed_at
          and coalesce(sd.clicked_at, sd.opened_at) >= o.processed_at - interval '7 days'
        order by (sd.clicked_at is not null) desc, coalesce(sd.clicked_at, sd.opened_at) desc
        limit 1
      ) hit on true
      where o.store_id = ${storeId}
        and o.customer_id is not null
        and o.cancelled_at is null
        and o.processed_at > now() - interval '14 days'
      on conflict (order_id, model) do nothing
      returning id`;
    console.log(`[attribution] store=${storeId} new=${inserted.length}`);
  });

  console.log("[jobs] lifecycle: scoring, planning and attribution handlers registered");
}
