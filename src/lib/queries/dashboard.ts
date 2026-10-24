import { sql } from "@/lib/db";

/**
 * Read-only query helpers for the merchant dashboard.
 * Every helper takes the tenant `storeId` and filters by it. Numeric/bigint
 * columns come back from postgres.js as strings — callers convert with Number().
 */

const PAGE_SIZE = 25;

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------
export type OverviewStats = {
  revenue30d: number;
  revenuePrev30d: number;
  emailsSent30d: number;
  emailsSentPrev30d: number;
  subscribed: number;
  pendingBriefs: number;
};

export async function overviewStats(storeId: string): Promise<OverviewStats> {
  const [r] = await sql<
    {
      revenue_30d: string;
      revenue_prev: string;
      sent_30d: string;
      sent_prev: string;
      subscribed: string;
      pending: string;
    }[]
  >`
    select
      (select coalesce(sum(amount), 0) from attributions
         where store_id = ${storeId} and created_at >= now() - interval '30 days') as revenue_30d,
      (select coalesce(sum(amount), 0) from attributions
         where store_id = ${storeId}
           and created_at >= now() - interval '60 days' and created_at < now() - interval '30 days') as revenue_prev,
      (select count(*) from sends
         where store_id = ${storeId} and sent_at >= now() - interval '30 days') as sent_30d,
      (select count(*) from sends
         where store_id = ${storeId}
           and sent_at >= now() - interval '60 days' and sent_at < now() - interval '30 days') as sent_prev,
      (select count(*) from customers
         where store_id = ${storeId} and marketing_state = 'subscribed' and email is not null) as subscribed,
      (select count(*) from campaign_briefs
         where store_id = ${storeId} and status = 'draft') as pending`;
  return {
    revenue30d: Number(r.revenue_30d),
    revenuePrev30d: Number(r.revenue_prev),
    emailsSent30d: Number(r.sent_30d),
    emailsSentPrev30d: Number(r.sent_prev),
    subscribed: Number(r.subscribed),
    pendingBriefs: Number(r.pending),
  };
}

export type PendingBrief = {
  id: string;
  lifecycle_job: string;
  title: string;
  subject: string;
  audience_count: number | null;
  created_at: Date;
};

export async function pendingBriefs(storeId: string, limit = 5): Promise<PendingBrief[]> {
  return sql<PendingBrief[]>`
    select id, lifecycle_job, title, subject, audience_count, created_at
    from campaign_briefs
    where store_id = ${storeId} and status = 'draft'
    order by created_at desc
    limit ${limit}`;
}

export type ActivityItem = {
  id: string;
  actor: string;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  meta: Record<string, unknown>;
  created_at: Date;
};

export async function recentActivity(storeId: string, limit = 8): Promise<ActivityItem[]> {
  return sql<ActivityItem[]>`
    select id::text, actor, action, entity_type, entity_id, meta, created_at
    from audit_log
    where store_id = ${storeId}
    order by created_at desc
    limit ${limit}`;
}

// ---------------------------------------------------------------------------
// Shopify connection
// ---------------------------------------------------------------------------
export type ShopifyConnectionInfo = {
  shop_domain: string;
  installed_at: Date;
  last_backfill_at: Date | null;
  scopes: string;
};

/** Returns the active (not uninstalled) connection, never the access token. */
export async function shopifyConnection(storeId: string): Promise<ShopifyConnectionInfo | null> {
  const rows = await sql<ShopifyConnectionInfo[]>`
    select shop_domain, installed_at, last_backfill_at, scopes
    from shopify_connections
    where store_id = ${storeId} and uninstalled_at is null
    limit 1`;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Briefs (approvals page) — own query so the page does not depend on action return shapes
// ---------------------------------------------------------------------------
export type BriefStatus = "draft" | "approved" | "rejected" | "sent" | "expired";

export type BriefDetail = {
  id: string;
  lifecycle_job: string;
  status: BriefStatus;
  title: string;
  rationale: string;
  audience_count: number | null;
  subject: string;
  preheader: string;
  blocks: unknown;
  template_id: string | null;
  template_name: string | null;
  preview_html: string | null;
  discount_code: string | null;
  discount_suggestion: { percent?: number; reason?: string } | null;
  send_window_start: Date | null;
  send_window_end: Date | null;
  approved_at: Date | null;
  created_at: Date;
};

export async function briefsByStatus(storeId: string, statuses: BriefStatus[], limit = 30): Promise<BriefDetail[]> {
  return sql<BriefDetail[]>`
    select b.id, b.lifecycle_job, b.status, b.title, b.rationale, b.audience_count,
           b.subject, b.preheader, b.blocks, b.template_id,
           t.name as template_name, t.preview_html,
           b.discount_code, b.usage->'brief_meta'->'discount_suggestion' as discount_suggestion,
           b.send_window_start, b.send_window_end, b.approved_at, b.created_at
    from campaign_briefs b
    left join templates t on t.id = b.template_id
    where b.store_id = ${storeId} and b.status in ${sql(statuses)}
    order by b.created_at desc
    limit ${limit}`;
}

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------
export type CampaignListItem = {
  id: string;
  name: string;
  status: string;
  scheduled_for: Date | null;
  finished_at: Date | null;
  recipients: number;
  sent: number;
  delivered: number;
  clicked: number;
  revenue: number;
};

export async function campaignsList(storeId: string): Promise<CampaignListItem[]> {
  const rows = await sql<
    {
      id: string;
      name: string;
      status: string;
      scheduled_for: Date | null;
      finished_at: Date | null;
      recipients: number;
      sent: string;
      delivered: string;
      clicked: string;
      revenue: string;
    }[]
  >`
    select c.id, c.name, c.status, c.scheduled_for, c.finished_at, c.recipients,
           coalesce(s.sent, 0) as sent, coalesce(s.delivered, 0) as delivered,
           coalesce(s.clicked, 0) as clicked, coalesce(a.revenue, 0) as revenue
    from campaigns c
    left join lateral (
      select count(*) filter (where sent_at is not null) as sent,
             count(*) filter (where delivered_at is not null) as delivered,
             count(*) filter (where clicked_at is not null) as clicked
      from sends where campaign_id = c.id and store_id = ${storeId}
    ) s on true
    left join lateral (
      select sum(amount) as revenue from attributions where campaign_id = c.id and store_id = ${storeId}
    ) a on true
    where c.store_id = ${storeId}
    order by coalesce(c.scheduled_for, c.created_at) desc
    limit 200`;
  return rows.map((r) => ({
    ...r,
    recipients: Number(r.recipients),
    sent: Number(r.sent),
    delivered: Number(r.delivered),
    clicked: Number(r.clicked),
    revenue: Number(r.revenue),
  }));
}

export type CampaignDetail = {
  id: string;
  name: string;
  subject: string;
  status: string;
  scheduled_for: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
  recipients: number;
  counts: {
    total: number;
    queued: number;
    skipped: number;
    sent: number;
    delivered: number;
    opened: number;
    clicked: number;
    bounced: number;
    complained: number;
    failed: number;
  };
  openRate: number;
  clickRate: number;
  revenue: number;
  skipReasons: { reason: string; count: number }[];
};

export async function campaignDetail(storeId: string, id: string): Promise<CampaignDetail | null> {
  const [c] = await sql<
    {
      id: string;
      name: string;
      subject: string;
      status: string;
      scheduled_for: Date | null;
      started_at: Date | null;
      finished_at: Date | null;
      recipients: number;
    }[]
  >`select id, name, subject, status, scheduled_for, started_at, finished_at, recipients
    from campaigns where id = ${id} and store_id = ${storeId} limit 1`;
  if (!c) return null;

  const [k] = await sql<Record<string, string>[]>`
    select count(*) as total,
           count(*) filter (where status = 'queued') as queued,
           count(*) filter (where status = 'skipped') as skipped,
           count(*) filter (where status = 'failed') as failed,
           count(*) filter (where sent_at is not null) as sent,
           count(*) filter (where delivered_at is not null) as delivered,
           count(*) filter (where opened_at is not null) as opened,
           count(*) filter (where clicked_at is not null) as clicked,
           count(*) filter (where bounced_at is not null) as bounced,
           count(*) filter (where complained_at is not null) as complained
    from sends where campaign_id = ${id} and store_id = ${storeId}`;

  const [rev] = await sql<{ revenue: string }[]>`
    select coalesce(sum(amount), 0) as revenue from attributions
    where campaign_id = ${id} and store_id = ${storeId}`;

  const reasons = await sql<{ reason: string; count: string }[]>`
    select coalesce(skip_reason, 'unknown') as reason, count(*) as count
    from sends
    where campaign_id = ${id} and store_id = ${storeId} and status = 'skipped'
    group by 1 order by count(*) desc`;

  const counts = {
    total: Number(k.total),
    queued: Number(k.queued),
    skipped: Number(k.skipped),
    sent: Number(k.sent),
    delivered: Number(k.delivered),
    opened: Number(k.opened),
    clicked: Number(k.clicked),
    bounced: Number(k.bounced),
    complained: Number(k.complained),
    failed: Number(k.failed),
  };

  return {
    ...c,
    recipients: Number(c.recipients),
    counts,
    openRate: counts.delivered ? counts.opened / counts.delivered : 0,
    clickRate: counts.delivered ? counts.clicked / counts.delivered : 0,
    revenue: Number(rev.revenue),
    skipReasons: reasons.map((r) => ({ reason: r.reason, count: Number(r.count) })),
  };
}

export type CampaignSendRow = {
  id: string;
  email: string;
  status: string;
  skip_reason: string | null;
  sent_at: Date | null;
  delivered_at: Date | null;
  opened_at: Date | null;
  clicked_at: Date | null;
};

export async function campaignSends(
  storeId: string,
  campaignId: string,
  page = 1,
): Promise<{ rows: CampaignSendRow[]; total: number; page: number; pageSize: number }> {
  const p = Math.max(1, Math.floor(page) || 1);
  const [t] = await sql<{ n: string }[]>`
    select count(*) as n from sends where campaign_id = ${campaignId} and store_id = ${storeId}`;
  const rows = await sql<CampaignSendRow[]>`
    select id, email::text as email, status, skip_reason, sent_at, delivered_at, opened_at, clicked_at
    from sends
    where campaign_id = ${campaignId} and store_id = ${storeId}
    order by coalesce(sent_at, delivered_at) desc nulls last, id
    limit ${PAGE_SIZE} offset ${(p - 1) * PAGE_SIZE}`;
  return { rows, total: Number(t.n), page: p, pageSize: PAGE_SIZE };
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------
export type CustomerRow = {
  id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  marketing_state: string;
  orders_count: number;
  total_spent: number;
  last_order_at: Date | null;
  rfm_segment: string | null;
  churn_risk: number | null;
  repurchase_score: number | null;
};

type RawCustomerRow = Omit<CustomerRow, "total_spent" | "churn_risk" | "repurchase_score" | "orders_count"> & {
  total_spent: string;
  orders_count: number;
  churn_risk: string | null;
  repurchase_score: string | null;
};

function normalizeCustomer(r: RawCustomerRow): CustomerRow {
  return {
    ...r,
    orders_count: Number(r.orders_count),
    total_spent: Number(r.total_spent),
    churn_risk: r.churn_risk === null ? null : Number(r.churn_risk),
    repurchase_score: r.repurchase_score === null ? null : Number(r.repurchase_score),
  };
}

export async function customersList(
  storeId: string,
  { q, page = 1 }: { q?: string; page?: number } = {},
): Promise<{ rows: CustomerRow[]; total: number; page: number; pageSize: number }> {
  const p = Math.max(1, Math.floor(page) || 1);
  const term = q?.trim() ? `%${q.trim().replace(/[\\%_]/g, "\\$&")}%` : null;
  const filter = term
    ? sql`and (c.email::text ilike ${term} or c.first_name ilike ${term} or c.last_name ilike ${term})`
    : sql``;

  const [t] = await sql<{ n: string }[]>`
    select count(*) as n from customers c where c.store_id = ${storeId} ${filter}`;
  const offset = (p - 1) * PAGE_SIZE;

  let rows: RawCustomerRow[];
  try {
    // customer_scores comes from migration 0002 (rfm_segment, churn_risk, repurchase_score).
    rows = await sql<RawCustomerRow[]>`
      select c.id, c.email::text as email, c.first_name, c.last_name, c.marketing_state,
             c.orders_count, c.total_spent, c.last_order_at,
             cs.rfm_segment, cs.churn_risk, cs.repurchase_score
      from customers c
      left join customer_scores cs on cs.customer_id = c.id
      where c.store_id = ${storeId} ${filter}
      order by c.last_order_at desc nulls last, c.created_at desc
      limit ${PAGE_SIZE} offset ${offset}`;
  } catch (err) {
    // 42P01 undefined_table / 42703 undefined_column: scoring migration not applied yet — degrade gracefully.
    const code = (err as { code?: string }).code;
    if (code !== "42P01" && code !== "42703") throw err;
    rows = await sql<RawCustomerRow[]>`
      select c.id, c.email::text as email, c.first_name, c.last_name, c.marketing_state,
             c.orders_count, c.total_spent, c.last_order_at,
             null::text as rfm_segment, null::numeric as churn_risk, null::numeric as repurchase_score
      from customers c
      where c.store_id = ${storeId} ${filter}
      order by c.last_order_at desc nulls last, c.created_at desc
      limit ${PAGE_SIZE} offset ${offset}`;
  }
  return { rows: rows.map(normalizeCustomer), total: Number(t.n), page: p, pageSize: PAGE_SIZE };
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------
export type ReportRow = {
  id: string;
  name: string;
  sent_on: Date | null;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  unsubscribed: number;
  revenue: number;
};

export type ReportsSummary = {
  campaigns: ReportRow[];
  totals30d: Omit<ReportRow, "id" | "name" | "sent_on">;
};

export async function reportsSummary(storeId: string): Promise<ReportsSummary> {
  const rows = await sql<Record<string, string | Date | null>[]>`
    select c.id, c.name, coalesce(c.finished_at, c.started_at, c.scheduled_for) as sent_on,
           coalesce(s.sent, 0) as sent, coalesce(s.delivered, 0) as delivered,
           coalesce(s.opened, 0) as opened, coalesce(s.clicked, 0) as clicked,
           coalesce(s.bounced, 0) as bounced,
           coalesce(u.unsubscribed, 0) as unsubscribed, coalesce(a.revenue, 0) as revenue
    from campaigns c
    left join lateral (
      select count(*) filter (where sent_at is not null) as sent,
             count(*) filter (where delivered_at is not null) as delivered,
             count(*) filter (where opened_at is not null) as opened,
             count(*) filter (where clicked_at is not null) as clicked,
             count(*) filter (where bounced_at is not null) as bounced
      from sends where campaign_id = c.id and store_id = ${storeId}
    ) s on true
    left join lateral (
      select count(*) as unsubscribed from events
      where campaign_id = c.id and store_id = ${storeId} and type = 'unsubscribed'
    ) u on true
    left join lateral (
      select sum(amount) as revenue from attributions where campaign_id = c.id and store_id = ${storeId}
    ) a on true
    where c.store_id = ${storeId}
    order by coalesce(c.finished_at, c.started_at, c.scheduled_for, c.created_at) desc
    limit 100`;

  const [t] = await sql<Record<string, string>[]>`
    select
      (select count(*) from sends where store_id = ${storeId} and sent_at >= now() - interval '30 days') as sent,
      (select count(*) from sends where store_id = ${storeId} and delivered_at >= now() - interval '30 days') as delivered,
      (select count(*) from sends where store_id = ${storeId} and opened_at >= now() - interval '30 days') as opened,
      (select count(*) from sends where store_id = ${storeId} and clicked_at >= now() - interval '30 days') as clicked,
      (select count(*) from sends where store_id = ${storeId} and bounced_at >= now() - interval '30 days') as bounced,
      (select count(*) from events where store_id = ${storeId} and type = 'unsubscribed'
         and campaign_id is not null and occurred_at >= now() - interval '30 days') as unsubscribed,
      (select coalesce(sum(amount), 0) from attributions
         where store_id = ${storeId} and created_at >= now() - interval '30 days') as revenue`;

  return {
    campaigns: rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      sent_on: (r.sent_on as Date | null) ?? null,
      sent: Number(r.sent),
      delivered: Number(r.delivered),
      opened: Number(r.opened),
      clicked: Number(r.clicked),
      bounced: Number(r.bounced),
      unsubscribed: Number(r.unsubscribed),
      revenue: Number(r.revenue),
    })),
    totals30d: {
      sent: Number(t.sent),
      delivered: Number(t.delivered),
      opened: Number(t.opened),
      clicked: Number(t.clicked),
      bounced: Number(t.bounced),
      unsubscribed: Number(t.unsubscribed),
      revenue: Number(t.revenue),
    },
  };
}
