import type { TransactionSql } from "postgres";
import type { CreateBatchOptions } from "resend";
import type { JSONContent } from "@maily-to/render";
import { audit, getStoreById, runAudienceQuery, sql, type StoreRow } from "../db";
import { env } from "../env";
import { resend, RESEND_BATCH_SIZE } from "../resend";
import { renderTemplate } from "./render";
import type { ItemRow } from "./variables";

/**
 * Send pipeline used by the pg-boss worker (src/jobs/email.ts).
 *
 * Hard rules enforced here (CLAUDE.md):
 *  1. only customers.marketing_state = 'subscribed' with an email are mailed
 *  2. suppressions are checked at prepare time AND again at send time; the weekly
 *     frequency cap is applied at prepare time (worker, after approval)
 *  3. a campaign linked to a brief only sends while that brief is approved/sent
 */

type CampaignRow = {
  id: string;
  store_id: string;
  brief_id: string | null;
  template_id: string | null;
  name: string;
  subject: string;
  preheader: string;
  status: string;
};

type BriefRow = {
  id: string;
  status: string;
  audience_sql: string | null;
  product_ids: string[];
  discount_code: string | null;
  template_id: string | null;
  blocks: unknown;
};

type SendRow = {
  id: string;
  customer_id: string;
  email: string;
  first_name: string | null;
  marketing_state: string;
};

const APP_URL = () => env().NEXT_PUBLIC_APP_URL.replace(/\/$/, "");

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function fromAddress(store: StoreRow): string {
  if (store.from_email) return `${store.from_name || store.name} <${store.from_email}>`;
  return env().RESEND_FROM_DEFAULT;
}

async function loadCampaign(campaignId: string): Promise<CampaignRow | null> {
  const rows = await sql<CampaignRow[]>`
    select id, store_id, brief_id, template_id, name, subject, preheader, status
    from campaigns where id = ${campaignId} limit 1`;
  return rows[0] ?? null;
}

async function loadBrief(storeId: string, briefId: string): Promise<BriefRow | null> {
  const rows = await sql<BriefRow[]>`
    select id, status, audience_sql, product_ids, discount_code, template_id, blocks
    from campaign_briefs where id = ${briefId} and store_id = ${storeId} limit 1`;
  return rows[0] ?? null;
}

async function failCampaign(campaign: CampaignRow, reason: string) {
  await sql`update campaigns set status = 'failed', finished_at = now()
            where id = ${campaign.id} and store_id = ${campaign.store_id} and status in ('queued','sending')`;
  await audit(campaign.store_id, "system", "campaign.failed", { type: "campaign", id: campaign.id }, { reason });
}

// ---------------------------------------------------------------------------
// prepareCampaign
// ---------------------------------------------------------------------------

/**
 * Resolves the audience, applies skip rules, inserts `sends` rows and returns the
 * queued send ids chunked for the batch endpoint. Safe to re-run (idempotent).
 */
export async function prepareCampaign(campaignId: string): Promise<string[][]> {
  const campaign = await loadCampaign(campaignId);
  if (!campaign) throw new Error(`campaign ${campaignId} not found`);
  if (campaign.status !== "queued" && campaign.status !== "sending") return [];
  const storeId = campaign.store_id;
  const store = await getStoreById(storeId);
  if (!store) throw new Error(`store ${storeId} not found`);

  // Audience from an approved brief, if any.
  let audienceIds: string[] = [];
  if (campaign.brief_id) {
    const brief = await loadBrief(storeId, campaign.brief_id);
    if (!brief || (brief.status !== "approved" && brief.status !== "sent")) {
      await failCampaign(campaign, "brief_not_approved");
      return [];
    }
    if (brief.audience_sql) audienceIds = await runAudienceQuery(storeId, brief.audience_sql);
  }

  await sql`update campaigns set status = 'sending', started_at = coalesce(started_at, now())
            where id = ${campaignId} and store_id = ${storeId} and status in ('queued','sending')`;

  // Rows that already exist (manual sends, or a previous attempt of this job).
  const existing = await sql<{ id: string; customer_id: string; status: string }[]>`
    select id, customer_id, status from sends where store_id = ${storeId} and campaign_id = ${campaignId}`;
  const existingByCustomer = new Map(existing.map((r) => [r.customer_id, r]));

  const candidates = new Set<string>(audienceIds);
  for (const r of existing) if (r.status === "queued") candidates.add(r.customer_id);
  // Skip customers whose row already reached a terminal state in a previous attempt.
  const toVet = [...candidates].filter((id) => {
    const e = existingByCustomer.get(id);
    return !e || e.status === "queued";
  });

  const cap = store.max_emails_per_customer_per_week;

  for (const ids of chunk(toVet, 1000)) {
    const customers = await sql<{ id: string; email: string | null; marketing_state: string }[]>`
      select id, email, marketing_state from customers
      where store_id = ${storeId} and id in ${sql(ids)}`;

    const emails = customers.map((c) => c.email?.toLowerCase()).filter((e): e is string => !!e);
    const suppressed = new Set<string>();
    if (emails.length > 0) {
      const sup = await sql<{ email: string }[]>`
        select email from suppressions where store_id = ${storeId} and email in ${sql(emails)}`;
      for (const s of sup) suppressed.add(s.email.toLowerCase());
    }

    const recent = new Map<string, number>();
    const cust = customers.map((c) => c.id);
    if (cust.length > 0) {
      const counts = await sql<{ customer_id: string; n: number }[]>`
        select customer_id, count(*)::int as n from sends
        where store_id = ${storeId} and customer_id in ${sql(cust)}
          and sent_at is not null and sent_at > now() - interval '7 days'
        group by customer_id`;
      for (const c of counts) recent.set(c.customer_id, c.n);
    }

    const inserts: { store_id: string; campaign_id: string; customer_id: string; email: string; status: string; skip_reason: string | null }[] = [];
    const skipUpdates: { id: string; reason: string }[] = [];

    for (const c of customers) {
      let skip: string | null = null;
      if (!c.email) skip = "no_email";
      else if (c.marketing_state !== "subscribed") skip = "not_subscribed";
      else if (suppressed.has(c.email.toLowerCase())) skip = "suppressed";
      else if ((recent.get(c.id) ?? 0) >= cap) skip = "frequency_cap";

      const prior = existingByCustomer.get(c.id);
      if (prior) {
        if (skip) skipUpdates.push({ id: prior.id, reason: skip });
      } else {
        inserts.push({
          store_id: storeId,
          campaign_id: campaignId,
          customer_id: c.id,
          email: c.email ?? "",
          status: skip ? "skipped" : "queued",
          skip_reason: skip,
        });
      }
    }

    for (const part of chunk(inserts, 500)) {
      await sql`insert into sends ${sql(part, "store_id", "campaign_id", "customer_id", "email", "status", "skip_reason")}
                on conflict (campaign_id, customer_id) do nothing`;
    }
    for (const u of skipUpdates) {
      await sql`update sends set status = 'skipped', skip_reason = ${u.reason}
                where id = ${u.id} and store_id = ${storeId} and status = 'queued'`;
    }
  }

  const queued = await sql<{ id: string }[]>`
    select id from sends where store_id = ${storeId} and campaign_id = ${campaignId} and status = 'queued' order by id`;
  await sql`update campaigns set recipients = (
              select count(*)::int from sends
              where store_id = ${storeId} and campaign_id = ${campaignId} and status <> 'skipped')
            where id = ${campaignId} and store_id = ${storeId}`;

  if (queued.length === 0) await finalizeCampaignIfDone(campaignId, storeId);
  return chunk(
    queued.map((q) => q.id),
    RESEND_BATCH_SIZE,
  );
}

// ---------------------------------------------------------------------------
// sendBatch
// ---------------------------------------------------------------------------

const fmtMoney = (v: unknown): string => {
  if (v === null || v === undefined || v === "") return "";
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(n);
};

async function loadRecommendations(storeId: string, productIds: string[], shopUrl: string): Promise<ItemRow[]> {
  if (productIds.length === 0) return [];
  const rows = await sql<
    { id: string; title: string; image_url: string | null; url: string | null; handle: string | null; price_min: string | null }[]
  >`
    select id, title, image_url, url, handle, price_min from products
    where store_id = ${storeId} and id in ${sql(productIds)}
      and coalesce(status, 'ACTIVE') = 'ACTIVE'`;
  const byId = new Map(rows.map((r) => [r.id, r]));
  return productIds
    .map((id) => byId.get(id))
    .filter((r): r is NonNullable<typeof r> => !!r)
    .slice(0, 6)
    .map((r) => ({
      title: r.title,
      image: r.image_url ?? "",
      image_url: r.image_url ?? "", // AI-built templates bind to `image_url`; seeds bind to `image`
      price: fmtMoney(r.price_min),
      url: r.url ?? (r.handle ? `${shopUrl}/products/${r.handle}` : shopUrl),
      quantity: "1",
    }));
}

type CartCtx = { url: string; items: ItemRow[] };

/**
 * Latest open checkout per customer. The Shopify sync writes `checkout_started`
 * events with props { abandoned_checkout_url, line_items[{product_id (gid), title, quantity, price}] }.
 * Line items carry no image, so we enrich from `products` by Shopify gid.
 */
async function loadCarts(db: TransactionSql, storeId: string, customerIds: string[], shopUrl: string): Promise<Map<string, CartCtx>> {
  const out = new Map<string, CartCtx>();
  if (customerIds.length === 0) return out;
  const rows = await db<{ customer_id: string; props: Record<string, unknown> }[]>`
    select distinct on (customer_id) customer_id, props
    from events
    where store_id = ${storeId}
      and type in ('checkout_started', 'checkout_abandoned')
      and customer_id in ${db(customerIds)}
      and occurred_at > now() - interval '7 days'
    order by customer_id, occurred_at desc`;

  const gids = new Set<string>();
  for (const r of rows) {
    const raw = ((r.props ?? {}).line_items ?? (r.props ?? {}).items ?? []) as unknown;
    if (Array.isArray(raw)) for (const i of raw as Record<string, unknown>[]) if (i.product_id) gids.add(String(i.product_id));
  }
  const prodRows = gids.size
    ? await db<{ shopify_id: string; image_url: string | null; url: string | null; handle: string | null }[]>`
        select shopify_id, image_url, url, handle from products
        where store_id = ${storeId} and shopify_id in ${db([...gids])}`
    : [];
  const byGid = new Map(prodRows.map((p) => [p.shopify_id, p]));

  for (const r of rows) {
    const props = r.props ?? {};
    const rawItems = (props.line_items ?? props.items ?? props.cart_items ?? []) as unknown;
    const items: ItemRow[] = Array.isArray(rawItems)
      ? (rawItems as Record<string, unknown>[]).map((i) => {
          const p = i.product_id ? byGid.get(String(i.product_id)) : undefined;
          const image = String(i.image ?? i.image_url ?? p?.image_url ?? "");
          return {
            title: String(i.title ?? ""),
            image,
            image_url: image,
            price: fmtMoney(i.price),
            url: String(i.url ?? p?.url ?? (p?.handle ? `${shopUrl}/products/${p.handle}` : shopUrl)),
            quantity: String(i.quantity ?? 1),
          };
        })
      : [];
    const url = String(props.abandoned_checkout_url ?? props.checkout_url ?? props.cart_url ?? props.url ?? shopUrl);
    out.set(r.customer_id, { url, items });
  }
  return out;
}

function discountPercent(brief: BriefRow | null): string {
  const b = (brief?.blocks ?? {}) as Record<string, unknown>;
  const d = (b.discount ?? {}) as Record<string, unknown>;
  const raw = d.percent ?? b.discount_percent ?? "";
  return raw === "" || raw === null || raw === undefined ? "" : String(raw).replace(/[^\d.]/g, "");
}

export type SendBatchResult = { sent: number; failed: number; skipped: number };

class TransientSendError extends Error {}

export async function sendBatch(campaignId: string, sendIds: string[]): Promise<SendBatchResult> {
  const result: SendBatchResult = { sent: 0, failed: 0, skipped: 0 };
  const campaign = await loadCampaign(campaignId);
  if (!campaign) throw new Error(`campaign ${campaignId} not found`);
  const storeId = campaign.store_id;
  if (sendIds.length === 0) return result;

  if (campaign.status === "cancelled" || campaign.status === "failed") {
    const n = await sql`update sends set status = 'skipped', skip_reason = 'cancelled'
                        where store_id = ${storeId} and campaign_id = ${campaignId}
                          and id in ${sql(sendIds)} and status = 'queued'`;
    result.skipped = n.count;
    return result;
  }

  const store = await getStoreById(storeId);
  if (!store) throw new Error(`store ${storeId} not found`);

  const brief = campaign.brief_id ? await loadBrief(storeId, campaign.brief_id) : null;
  if (campaign.brief_id && (!brief || (brief.status !== "approved" && brief.status !== "sent"))) {
    await failCampaign(campaign, "brief_not_approved");
    return result;
  }

  const templateId = campaign.template_id ?? brief?.template_id ?? null;
  const tpl = templateId
    ? (
        await sql<{ content_json: JSONContent; subject: string; preheader: string }[]>`
          select content_json, subject, preheader from templates
          where id = ${templateId} and (store_id = ${storeId} or store_id is null) limit 1`
      )[0]
    : undefined;
  if (!tpl) {
    const n = await sql`update sends set status = 'failed', error = 'template_missing'
                        where store_id = ${storeId} and campaign_id = ${campaignId}
                          and id in ${sql(sendIds)} and status = 'queued'`;
    result.failed = n.count;
    await finalizeCampaignIfDone(campaignId, storeId);
    return result;
  }

  const conn = (
    await sql<{ shop_domain: string }[]>`
      select shop_domain from shopify_connections where store_id = ${storeId} and uninstalled_at is null limit 1`
  )[0];
  const shopUrl = conn ? `https://${conn.shop_domain}` : APP_URL();
  const recommendations = brief ? await loadRecommendations(storeId, brief.product_ids, shopUrl) : [];
  const discountCode = brief?.discount_code ?? "";
  const percent = discountPercent(brief);
  const subject = campaign.subject || tpl.subject;
  const preheader = campaign.preheader || tpl.preheader;
  const from = fromAddress(store);

  await sql.begin(async (tx) => {
    // Lock the rows so a duplicate job can never double-send the same recipients.
    const rows = await tx<SendRow[]>`
      select s.id, s.customer_id, s.email, c.first_name, c.marketing_state
      from sends s
      join customers c on c.id = s.customer_id and c.store_id = s.store_id
      where s.store_id = ${storeId} and s.campaign_id = ${campaignId}
        and s.id in ${tx(sendIds)} and s.status = 'queued'
      order by s.id
      for update of s skip locked`;
    if (rows.length === 0) return;

    // Hard rule: re-check suppression + marketing_state at send time.
    const sup = await tx<{ email: string }[]>`
      select email from suppressions
      where store_id = ${storeId} and email in ${tx(rows.map((r) => r.email))}`;
    const suppressed = new Set(sup.map((s) => s.email.toLowerCase()));

    const eligible: SendRow[] = [];
    for (const r of rows) {
      const reason = r.marketing_state !== "subscribed" ? "not_subscribed" : suppressed.has(r.email.toLowerCase()) ? "suppressed" : null;
      if (reason) {
        await tx`update sends set status = 'skipped', skip_reason = ${reason} where id = ${r.id} and store_id = ${storeId}`;
        result.skipped += 1;
      } else {
        eligible.push(r);
      }
    }
    if (eligible.length === 0) return;

    const carts = await loadCarts(tx, storeId, eligible.map((e) => e.customer_id), shopUrl);

    // Render per recipient.
    type Rendered = { send: SendRow; subject: string; html: string; text: string; unsubscribeUrl: string };
    const rendered: Rendered[] = [];
    const renderErrors: { send: SendRow; error: string }[] = [];
    for (const group of chunk(eligible, 10)) {
      await Promise.all(
        group.map(async (send) => {
          const unsubscribeUrl = `${APP_URL()}/u/${send.id}`;
          const cart = carts.get(send.customer_id);
          const variables: Record<string, string> = {
            "customer.email": send.email,
            "shop.name": store.name,
            "shop.url": shopUrl,
            unsubscribe_url: unsubscribeUrl,
            preferences_url: unsubscribeUrl,
            "cart.url": cart?.url || shopUrl,
          };
          if (send.first_name) variables["customer.first_name"] = send.first_name;
          if (store.brand_logo_url) variables["shop.logo_url"] = store.brand_logo_url;
          if (discountCode) variables["discount.code"] = discountCode;
          if (percent) variables["discount.percent"] = percent;
          try {
            const out = await renderTemplate({
              contentJson: tpl.content_json,
              subject,
              preheader,
              store,
              variables,
              payloads: {
                cart_items: cart?.items ?? [],
                recommendations,
                has_discount: !!discountCode,
              },
            });
            rendered.push({ send, subject: out.subject, html: out.html, text: out.text, unsubscribeUrl });
          } catch (e) {
            renderErrors.push({ send, error: `render_failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500) });
          }
        }),
      );
    }

    for (const f of renderErrors) {
      await tx`update sends set status = 'failed', error = ${f.error} where id = ${f.send.id} and store_id = ${storeId}`;
      result.failed += 1;
    }
    if (rendered.length === 0) return;
    rendered.sort((a, b) => (a.send.id < b.send.id ? -1 : 1));

    const payload: CreateBatchOptions = rendered.map((r) => ({
      from,
      to: [r.send.email],
      subject: r.subject,
      html: r.html,
      text: r.text,
      ...(store.reply_to ? { replyTo: store.reply_to } : {}),
      headers: {
        "List-Unsubscribe": `<${r.unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
      tags: [
        { name: "campaign_id", value: campaignId },
        { name: "send_id", value: r.send.id },
      ],
    }));

    const { data, error } = await resend.batch.send(payload, {
      batchValidation: "permissive",
      // Same recipients => same key, so a retry after a crash cannot double-send.
      idempotencyKey: `campaign-${campaignId}-${rendered[0].send.id}-${rendered.length}`,
    });

    if (error) {
      const code = error.statusCode ?? 0;
      const transient = code === 0 || code === 429 || code >= 500 || /idempotent/i.test(error.name);
      if (transient) throw new TransientSendError(`resend batch: ${error.name}: ${error.message}`);
      const msg = `${error.name}: ${error.message}`.slice(0, 500);
      for (const r of rendered) {
        await tx`update sends set status = 'failed', error = ${msg} where id = ${r.send.id} and store_id = ${storeId}`;
        result.failed += 1;
      }
      return;
    }

    const failedAt = new Map<number, string>();
    for (const e of (data as { errors?: { index: number; message: string }[] } | null)?.errors ?? []) {
      failedAt.set(e.index, e.message);
    }
    // Resend returns ids only for accepted emails, in request order (failed indexes are omitted).
    const accepted = (data?.data ?? []).map((d) => d.id);
    let cursor = 0;
    const outcomes = rendered.map((r, i) => {
      const failMsg = failedAt.get(i);
      return { r, failMsg, providerId: failMsg === undefined ? accepted[cursor++] : undefined };
    });

    await Promise.all(
      outcomes.map(async ({ r, failMsg, providerId }) => {
        if (!providerId) {
          const msg = (failMsg ?? "missing_provider_id").slice(0, 500);
          await tx`update sends set status = 'failed', error = ${msg} where id = ${r.send.id} and store_id = ${storeId}`;
          result.failed += 1;
          return;
        }
        await tx`update sends set status = 'sent', provider_id = ${providerId}, sent_at = now(), error = null
                 where id = ${r.send.id} and store_id = ${storeId}`;
        await tx`insert into events (store_id, customer_id, type, campaign_id, props, dedupe_key)
                 values (${storeId}, ${r.send.customer_id}, 'email_sent', ${campaignId},
                         ${tx.json({ send_id: r.send.id, provider_id: providerId } as never)}, ${`send:${r.send.id}:sent`})
                 on conflict (store_id, dedupe_key) do nothing`;
        result.sent += 1;
      }),
    );
  });

  await finalizeCampaignIfDone(campaignId, storeId);
  return result;
}

/** Marks the campaign sent/failed once no send is left in 'queued'. */
export async function finalizeCampaignIfDone(campaignId: string, storeId: string): Promise<boolean> {
  const [c] = await sql<{ queued: number; ok: number; failed: number; skipped: number }[]>`
    select count(*) filter (where status = 'queued')::int as queued,
           count(*) filter (where status in ('sent','delivered','bounced','complained'))::int as ok,
           count(*) filter (where status = 'failed')::int as failed,
           count(*) filter (where status = 'skipped')::int as skipped
    from sends where store_id = ${storeId} and campaign_id = ${campaignId}`;
  if (!c || c.queued > 0) return false;

  const finalStatus = c.ok === 0 && c.failed > 0 ? "failed" : "sent";
  const done = await sql<{ id: string; brief_id: string | null }[]>`
    update campaigns set status = ${finalStatus}, finished_at = now()
    where id = ${campaignId} and store_id = ${storeId} and status = 'sending'
    returning id, brief_id`;
  if (done.length === 0) return false;

  if (done[0].brief_id) {
    await sql`update campaign_briefs set status = 'sent'
              where id = ${done[0].brief_id} and store_id = ${storeId} and status = 'approved'`;
  }
  await audit(storeId, "system", "campaign.sent", { type: "campaign", id: campaignId }, { status: finalStatus, sent: c.ok, failed: c.failed, skipped: c.skipped });
  return true;
}

// ---------------------------------------------------------------------------
// Resend webhook events
// ---------------------------------------------------------------------------

export type ResendWebhookEvent = {
  type: string;
  created_at?: string;
  data?: {
    email_id?: string;
    created_at?: string;
    bounce?: { type?: string; subType?: string; message?: string };
    click?: { link?: string; timestamp?: string };
    [k: string]: unknown;
  };
};

const EVENT_MAP = {
  "email.delivered": "email_delivered",
  "email.opened": "email_opened",
  "email.clicked": "email_clicked",
  "email.bounced": "email_bounced",
  "email.complained": "email_complained",
} as const;

export async function handleResendEvent(event: ResendWebhookEvent, eventId?: string): Promise<void> {
  const eventType = EVENT_MAP[event.type as keyof typeof EVENT_MAP];
  if (!eventType) return; // sent / delivery_delayed / failed etc. are not tracked

  const emailId = event.data?.email_id;
  if (!emailId) return;

  const parsed = Date.parse(event.created_at ?? event.data?.created_at ?? "");
  const when = new Date(Number.isNaN(parsed) ? Date.now() : parsed);

  const found = await sql<{ id: string; store_id: string; campaign_id: string; customer_id: string; email: string }[]>`
    select id, store_id, campaign_id, customer_id, email from sends where provider_id = ${emailId} limit 1`;
  const send = found[0];
  if (!send) return; // test emails or foreign ids
  const storeId = send.store_id;

  switch (eventType) {
    case "email_delivered":
      await sql`update sends set delivered_at = coalesce(delivered_at, ${when}),
                  status = case when status in ('queued','sent') then 'delivered' else status end
                where id = ${send.id} and store_id = ${storeId}`;
      break;
    case "email_opened":
      await sql`update sends set opened_at = coalesce(opened_at, ${when}) where id = ${send.id} and store_id = ${storeId}`;
      break;
    case "email_clicked":
      await sql`update sends set clicked_at = coalesce(clicked_at, ${when}) where id = ${send.id} and store_id = ${storeId}`;
      break;
    case "email_bounced":
      await sql`update sends set status = 'bounced', bounced_at = coalesce(bounced_at, ${when})
                where id = ${send.id} and store_id = ${storeId}`;
      break;
    case "email_complained":
      await sql`update sends set status = 'complained', complained_at = coalesce(complained_at, ${when})
                where id = ${send.id} and store_id = ${storeId}`;
      break;
  }

  const props: Record<string, unknown> = { send_id: send.id, provider_id: emailId };
  if (event.data?.click?.link) props.link = event.data.click.link;
  if (event.data?.bounce) props.bounce = event.data.bounce;
  const dedupe = `resend:${eventId ?? `${emailId}:${event.type}:${event.created_at ?? ""}`}`;
  await sql`insert into events (store_id, customer_id, type, occurred_at, campaign_id, props, dedupe_key)
            values (${storeId}, ${send.customer_id}, ${eventType}, ${when}, ${send.campaign_id},
                    ${sql.json(props as never)}, ${dedupe})
            on conflict (store_id, dedupe_key) do nothing`;

  if (eventType === "email_bounced" || eventType === "email_complained") {
    const reason = eventType === "email_bounced" ? "bounced" : "complained";
    await sql`insert into suppressions (store_id, email, reason, source)
              values (${storeId}, ${send.email}, ${reason}, 'resend')
              on conflict (store_id, email) do nothing`;

    const hardBounce = eventType === "email_bounced" && event.data?.bounce?.type === "Permanent";
    if (hardBounce) {
      await setCustomerState(storeId, send.customer_id, "invalid", event);
    } else if (eventType === "email_complained") {
      // A spam complaint is an opt-out.
      await setCustomerState(storeId, send.customer_id, "unsubscribed", event);
    }
  }
}

async function setCustomerState(storeId: string, customerId: string, state: "invalid" | "unsubscribed", event: ResendWebhookEvent) {
  const changed = await sql`update customers set marketing_state = ${state}, consent_updated_at = now()
                            where id = ${customerId} and store_id = ${storeId} and marketing_state <> ${state}`;
  if (changed.count === 0) return;
  await sql`insert into consent_events (store_id, customer_id, state, source, raw)
            values (${storeId}, ${customerId}, ${state}, 'resend_webhook', ${sql.json(event as never)})`;
}
