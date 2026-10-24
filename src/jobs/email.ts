import type { PgBoss } from "pg-boss";
import { env } from "../lib/env";
import { enqueue, JOBS } from "../lib/queue";
import { handleResendEvent, prepareCampaign, sendBatch, type ResendWebhookEvent } from "../lib/email/send";

type CampaignSendData = { campaignId: string };
type CampaignSendBatchData = { campaignId: string; sendIds: string[] };
type ResendEventData = { event?: ResendWebhookEvent; svixId?: string } & Partial<ResendWebhookEvent>;

/**
 * Email jobs. pg-boss v12 hands work handlers an ARRAY of jobs, so every handler
 * runs with batchSize 1 and destructures `[job]`.
 */
export async function registerEmailJobs(boss: PgBoss) {
  // Fan-out: resolve audience + skip rules, then one job per 100 recipients.
  await boss.work<CampaignSendData>(JOBS.CAMPAIGN_SEND, { batchSize: 1 }, async ([job]) => {
    const { campaignId } = job.data;
    const chunks = await prepareCampaign(campaignId);
    for (const sendIds of chunks) {
      await enqueue(JOBS.CAMPAIGN_SEND_BATCH, { campaignId, sendIds } satisfies CampaignSendBatchData);
    }
    console.log(`[email] campaign ${campaignId}: ${chunks.length} batch(es) queued`);
  });

  // Resend allows ~2 requests/second by default, so keep batch concurrency low.
  await boss.work<CampaignSendBatchData>(
    JOBS.CAMPAIGN_SEND_BATCH,
    { batchSize: 1, localConcurrency: Math.min(env().WORKER_CONCURRENCY, 2) },
    async ([job]) => {
      const { campaignId, sendIds } = job.data;
      const r = await sendBatch(campaignId, sendIds);
      console.log(`[email] campaign ${campaignId}: sent=${r.sent} failed=${r.failed} skipped=${r.skipped}`);
    },
  );

  await boss.work<ResendEventData>(JOBS.RESEND_EVENT, { batchSize: 1 }, async ([job]) => {
    const data = job.data;
    const event = (data.event ?? data) as ResendWebhookEvent;
    await handleResendEvent(event, data.svixId);
  });
}
