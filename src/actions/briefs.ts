"use server";

import { z } from "zod";
import { requireStore } from "@/lib/auth";
import { audit, sql } from "@/lib/db";
import { enqueue, JOBS } from "@/lib/queue";
import { BlocksSchema } from "@/lib/ai/brief-schema";
import { generateBrief, type BriefRow } from "@/lib/ai/briefs";
import { createTemplateFromBrief } from "@/lib/ai/brief-to-maily";
import { computeAudienceStats, isLifecycleJob, type LifecycleJob } from "@/lib/lifecycle/jobs";

type BriefStatus = BriefRow["status"];
const STATUSES: BriefStatus[] = ["draft", "approved", "rejected", "sent", "expired"];

export async function listBriefs(status?: BriefStatus): Promise<BriefRow[]> {
  const { store } = await requireStore();
  const filter = status && STATUSES.includes(status) ? sql`and status = ${status}` : sql``;
  return sql<BriefRow[]>`
    select * from campaign_briefs
    where store_id = ${store.id} ${filter}
    order by created_at desc
    limit 100`;
}

export async function getBrief(id: string): Promise<BriefRow | null> {
  const { store } = await requireStore();
  const [row] = await sql<BriefRow[]>`select * from campaign_briefs where id = ${id} and store_id = ${store.id} limit 1`;
  return row ?? null;
}

export async function approveBrief(id: string): Promise<{ briefId: string; campaignId: string; scheduledFor: Date }> {
  const { store, userId } = await requireStore();

  const [current] = await sql<BriefRow[]>`select * from campaign_briefs where id = ${id} and store_id = ${store.id} limit 1`;
  if (!current) throw new Error("Brief not found");
  if (current.status !== "draft") throw new Error(`Brief is ${current.status}, only drafts can be approved`);

  const templateId = current.template_id ?? (await createTemplateFromBrief(id, { storeId: store.id, actor: userId }));

  const now = new Date();
  const start = current.send_window_start ? new Date(current.send_window_start) : new Date(now.getTime() + 3_600_000);
  const scheduledFor = start.getTime() > now.getTime() ? start : now;

  const campaignId = await sql.begin(async (tx) => {
    const approved = await tx<{ id: string }[]>`
      update campaign_briefs
      set status = 'approved', approved_by = ${userId}, approved_at = now()
      where id = ${id} and store_id = ${store.id} and status = 'draft'
      returning id`;
    if (approved.length === 0) throw new Error("Brief was already handled");
    const [campaign] = await tx<{ id: string }[]>`
      insert into campaigns (store_id, brief_id, template_id, name, subject, preheader, status, scheduled_for)
      values (${store.id}, ${id}, ${templateId}, ${current.title}, ${current.subject}, ${current.preheader},
              'queued', ${scheduledFor})
      returning id`;
    return campaign.id;
  });

  await audit(store.id, userId, "brief.approved", { type: "campaign_brief", id }, {
    campaign_id: campaignId,
    scheduled_for: scheduledFor.toISOString(),
    audience_count: current.audience_count,
  });
  await audit(store.id, userId, "campaign.created", { type: "campaign", id: campaignId }, { brief_id: id });

  await enqueue(JOBS.CAMPAIGN_SEND, { campaignId }, { startAfter: scheduledFor, singletonKey: `campaign:${campaignId}` });

  return { briefId: id, campaignId, scheduledFor };
}

export async function rejectBrief(id: string, reason: string): Promise<void> {
  const { store, userId } = await requireStore();
  const rows = await sql<{ id: string }[]>`
    update campaign_briefs set status = 'rejected'
    where id = ${id} and store_id = ${store.id} and status = 'draft'
    returning id`;
  if (rows.length === 0) throw new Error("Draft brief not found");
  await audit(store.id, userId, "brief.rejected", { type: "campaign_brief", id }, { reason: reason.slice(0, 500) });
}

/** Re-runs the AI plan for the same job and audience; the old draft is expired. */
export async function regenerateBrief(id: string): Promise<BriefRow> {
  const { store, userId } = await requireStore();
  const [old] = await sql<BriefRow[]>`select * from campaign_briefs where id = ${id} and store_id = ${store.id} limit 1`;
  if (!old) throw new Error("Brief not found");
  if (old.status !== "draft") throw new Error("Only draft briefs can be regenerated");
  if (!old.audience_sql) throw new Error("Brief has no audience query to regenerate from");

  const job = (isLifecycleJob(old.lifecycle_job) ? old.lifecycle_job : "manual") as LifecycleJob | "manual";
  const stats = await computeAudienceStats(store.id, old.audience_sql);
  const fresh = await generateBrief({
    storeId: store.id,
    job,
    audienceSql: old.audience_sql,
    stats,
    productIds: old.product_ids ?? [],
  });
  await createTemplateFromBrief(fresh.id, { storeId: store.id, actor: userId });

  await sql`update campaign_briefs set status = 'expired' where id = ${id} and store_id = ${store.id} and status = 'draft'`;
  await audit(store.id, userId, "brief.regenerated", { type: "campaign_brief", id }, { replaced_by: fresh.id });

  const [row] = await sql<BriefRow[]>`select * from campaign_briefs where id = ${fresh.id} and store_id = ${store.id}`;
  return row;
}

/** Queues a lifecycle plan right now (bypasses the 24h "recent draft" guard). */
export async function planNow(job: LifecycleJob): Promise<void> {
  const { store, userId } = await requireStore();
  if (!isLifecycleJob(job)) throw new Error("Unknown lifecycle job");
  await enqueue(JOBS.LIFECYCLE_PLAN, { storeId: store.id, job, force: true }, { singletonKey: `plan:${store.id}:${job}` });
  await audit(store.id, userId, "brief.plan_requested", undefined, { job });
}

const CopySchema = z.object({
  subject: z.string().min(1).max(60),
  preheader: z.string().max(90),
  blocks: BlocksSchema,
});

/** Merchant edits to a draft; the template is re-rendered from the new blocks. */
export async function updateBriefCopy(
  id: string,
  copy: { subject: string; preheader: string; blocks: unknown },
): Promise<BriefRow> {
  const { store, userId } = await requireStore();
  const parsed = CopySchema.parse(copy);

  const rows = await sql<{ id: string }[]>`
    update campaign_briefs
    set subject = ${parsed.subject}, preheader = ${parsed.preheader}, blocks = ${sql.json(parsed.blocks as never)}
    where id = ${id} and store_id = ${store.id} and status = 'draft'
    returning id`;
  if (rows.length === 0) throw new Error("Draft brief not found");

  await createTemplateFromBrief(id, { storeId: store.id, actor: userId });
  await audit(store.id, userId, "brief.updated", { type: "campaign_brief", id }, { fields: ["subject", "preheader", "blocks"] });

  const [row] = await sql<BriefRow[]>`select * from campaign_briefs where id = ${id} and store_id = ${store.id}`;
  return row;
}
