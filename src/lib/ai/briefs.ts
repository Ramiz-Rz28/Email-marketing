import { audit, sql } from "../db";
import { generateStructured, type SystemBlock, type Usage } from "./client";
import { BriefSchema, type Block, type Brief } from "./brief-schema";
import { getStoreDigest, type AudienceStats, type LifecycleJob } from "../lifecycle/jobs";

export type BriefMeta = {
  tone_check: string;
  discount_suggestion: { percent: number; reason: string } | null;
};

export type BriefRow = {
  id: string;
  store_id: string;
  lifecycle_job: string;
  status: "draft" | "approved" | "rejected" | "sent" | "expired";
  title: string;
  rationale: string;
  audience_sql: string | null;
  audience_count: number | null;
  product_ids: string[];
  subject: string;
  preheader: string;
  /** Array of Block (see brief-schema.ts). Remaining AI output lives in usage.brief_meta. */
  blocks: Block[];
  template_id: string | null;
  send_window_start: Date | null;
  send_window_end: Date | null;
  discount_code: string | null;
  model: string | null;
  usage: (Usage & { brief_meta?: BriefMeta }) | null;
  approved_by: string | null;
  approved_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

// ---------------------------------------------------------------------------
// Prompt text. RULES and PLAYBOOKS are static so the cache prefix never changes.
// ---------------------------------------------------------------------------

const RULES = `You are the lifecycle email strategist inside an approval-controlled email marketing app for Shopify stores. You plan ONE email campaign brief per request. A human merchant reviews and approves every brief before anything is sent.

PRODUCT RULES (non-negotiable)
1. Approval-controlled: you only propose. Nothing is sent without merchant approval, and the system enforces suppressions, unsubscribes and weekly frequency caps at send time. Never promise or imply delivery timing guarantees.
2. Consent-first: recipients are customers who opted in to marketing. Write as a brand talking to people who asked to hear from it. Never mention how you know about their browsing or cart beyond what the email itself shows (the cart items block). Do not reference purchase history details, spending, or inferred traits.
3. No fake urgency or scarcity: never invent deadlines, countdowns, "only X left", "last chance", "selling fast", or "before it's gone". Never use guilt, fear or shame ("we miss you" is acceptable once, warm and light; "you're missing out" is not). A real discount may be mentioned plainly.
4. Discounts: only suggest a discount when the playbook allows it and the margin logic is sound (5 to 15 percent, rarely 20). The discount block is shown only when a discount code exists at send time, so the email must still read well without it. Never state a percentage or code inside paragraph text; use the discount block for that.
5. Privacy: you receive aggregate audience statistics only. Never invent customer names, emails or personal details. The only personalization token allowed is {{customer.first_name}} (it falls back to "there"); use it at most once, normally in the first heading or paragraph. Do not write any other {{token}}.
6. Honest claims: do not invent product features, materials, shipping times, return policies, reviews, or awards. Only describe products using the title, type and price in the store digest or candidate list.
7. Tone for modest-fashion and similar brands: warm, respectful, understated and elegant. Never focus on bodies or appearance, never sexualize, never use slang, hype or exclamation-heavy copy. Short sentences, plain words, sentence case. Honour the brand voice implied by the store digest.

OUTPUT CONTRACT (structured JSON that matches the provided schema)
- title: internal campaign name for the dashboard, under 60 characters.
- rationale: 2 to 3 sentences covering why now, who receives it (describe the audience using the statistics, never individuals), and the expected outcome.
- subject: at most 60 characters, specific, no ALL CAPS, no more than one punctuation mark of emphasis, no emoji.
- preheader: at most 90 characters, complements the subject and does not repeat it.
- blocks: 3 to 7 blocks in display order. Use only these types:
  heading {text}; paragraph {text}; products {source, product_ids?, max}; cta {label, url_var}; discount {headline, show_if_var:"discount.code"}; spacer {}.
  * Start with a heading. Keep paragraphs to 1 to 3 short sentences. One clear call to action (cta) near the end.
  * products.source "cart_items" renders the recipient's own abandoned cart (cart recovery only). "recommendations" renders per-recipient picks chosen at send time. "explicit" renders fixed products: product_ids MUST be copied exactly from the candidate list in the request; never invent ids. max is 1 to 4.
  * cta.url_var is "cart.url" (return to the recipient's cart; cart recovery only) or "shop.url" (the store).
  * discount blocks always use show_if_var "discount.code".
- send_window_hours_from_now: {start, end} in hours from now. Respect the playbook. Prefer reasonable local-time hours for the store's timezone (roughly 9am to 8pm), never overnight.
- discount_suggestion: {percent, reason} or null. Set null unless the playbook allows a discount and it is justified.
- tone_check: one sentence confirming the copy has no pressure tactics and no fake scarcity or urgency.

Respond with the JSON object only.`;

const PLAYBOOKS: Record<LifecycleJob | "manual", string> = {
  cart_recovery: `PLAYBOOK: cart_recovery
Audience: subscribed customers who started checkout 2 to 48 hours ago and did not order.
Goal: a gentle reminder that their items are saved. Use a products block with source "cart_items" and a cta with url_var "cart.url". Helpful and calm: no discount by default (set discount_suggestion to null unless audience statistics show a high average order value and a discount is clearly justified, then at most 10 percent). Send window: start 1 to 3 hours from now, end within 12 hours.`,
  second_purchase: `PLAYBOOK: second_purchase
Audience: subscribed customers with exactly one order, placed 7 to 30 days ago.
Goal: thank them and invite a second purchase with complementary items. Use a products block with source "recommendations" (or "explicit" with candidate ids), and a cta with url_var "shop.url". No cart language. A small first-repeat incentive (5 to 10 percent) may be suggested. Send window: start 2 to 6 hours from now, end within 24 hours.`,
  winback: `PLAYBOOK: winback
Audience: subscribed customers likely to lapse or due to reorder, with no order in 45+ days.
Goal: a warm, low-pressure return invitation featuring things they have liked. Use "recommendations" or "explicit" products and a cta with url_var "shop.url". A modest incentive (10 percent, at most 15) may be suggested; include a discount block only if you also suggest a discount. Send window: start 2 to 8 hours from now, end within 36 hours.`,
  affinity: `PLAYBOOK: affinity
Audience: active subscribed customers with a clear product-type preference, 14 to 180 days since their last order.
Goal: a curated, editorial pick from the product types they favour, featuring products they have not bought. Use "recommendations" or "explicit" products and a cta with url_var "shop.url". No discount (set discount_suggestion to null). Send window: start 4 to 12 hours from now, end within 48 hours.`,
  manual: `PLAYBOOK: manual
Audience: merchant-defined. Follow the product rules strictly, keep the email simple, and avoid discounts unless clearly justified. Send window: start 2 to 6 hours from now, end within 24 hours.`,
};

// ---------------------------------------------------------------------------

export type GenerateBriefInput = {
  storeId: string;
  job: LifecycleJob | "manual";
  audienceSql: string;
  stats: AudienceStats & { signals?: Record<string, number | string> };
  productIds: string[];
  defaultDiscount?: string;
};

const MAX_CANDIDATES = 12;

function addUsage(a: Usage | null, b: Usage): Usage {
  if (!a) return b;
  return {
    model: b.model,
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
    cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
  };
}

/** Plans one brief with the smart tier and saves it as a draft. */
export async function generateBrief(input: GenerateBriefInput): Promise<BriefRow> {
  const { storeId, job, audienceSql, stats } = input;

  const candidates =
    input.productIds.length === 0
      ? []
      : await sql<{ id: string; title: string; product_type: string | null }[]>`
          select id::text as id, title, product_type
          from products
          where store_id = ${storeId} and id = any(${input.productIds}::uuid[])`;
  const order = new Map(input.productIds.map((id, i) => [id, i]));
  candidates.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  const candidateList = candidates.slice(0, MAX_CANDIDATES);
  const candidateIds = new Set(candidateList.map((c) => c.id));

  const system: SystemBlock[] = [
    { text: RULES, cache: true },
    { text: await getStoreDigest(storeId), cache: true },
    { text: PLAYBOOKS[job], cache: false },
  ];

  // Per-run data only. Aggregates and product ids/titles; never customer emails or names.
  const baseUser = JSON.stringify({
    job,
    today: new Date().toISOString().slice(0, 10),
    audience_stats: stats,
    candidate_products: candidateList.map((c) => ({ id: c.id, title: c.title, type: c.product_type })),
    ...(input.defaultDiscount ? { suggested_default_discount: input.defaultDiscount } : {}),
  });

  let usage: Usage | null = null;
  let brief: Brief | null = null;
  let lastError = "";
  for (let attempt = 0; attempt < 2 && !brief; attempt++) {
    const user = attempt === 0 ? baseUser : `${baseUser}\n\nYour previous answer was rejected: ${lastError}. Fix it and answer again.`;
    try {
      const res = await generateStructured({ tier: "smart", system, user, schema: BriefSchema, maxTokens: 2500 });
      usage = addUsage(usage, res.usage);
      brief = res.data;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const validation = (e instanceof Error && e.name === "ZodError") || msg.startsWith("Model returned non-JSON");
      if (!validation || attempt === 1) throw e;
      lastError = msg.slice(0, 400);
    }
  }
  if (!brief || !usage) throw new Error("brief generation failed");

  // Sanitize product references against the candidate list.
  const blocks: Block[] = brief.blocks.map((b) => {
    if (b.type !== "products") return b;
    const max = Math.min(4, Math.max(1, Math.round(b.max) || 4));
    if (b.source !== "explicit") return { type: "products", source: b.source, max };
    const ids = [...new Set(b.product_ids ?? [])].filter((id) => candidateIds.has(id)).slice(0, max);
    return ids.length > 0
      ? { type: "products", source: "explicit", product_ids: ids, max }
      : { type: "products", source: "recommendations", max };
  });

  const explicitIds = blocks.flatMap((b) => (b.type === "products" ? (b.product_ids ?? []) : []));
  const productIds = [...new Set([...explicitIds, ...candidateList.map((c) => c.id)])];

  const now = Date.now();
  const startH = Math.max(0, brief.send_window_hours_from_now.start);
  const endH = Math.max(startH + 1, brief.send_window_hours_from_now.end);
  const windowStart = new Date(now + startH * 3_600_000);
  const windowEnd = new Date(now + endH * 3_600_000);

  const meta: BriefMeta = {
    tone_check: brief.tone_check,
    discount_suggestion: brief.discount_suggestion ?? null,
  };
  const usageJson = { ...usage, brief_meta: meta };

  const [row] = await sql<BriefRow[]>`
    insert into campaign_briefs (
      store_id, lifecycle_job, status, title, rationale, audience_sql, audience_count, product_ids,
      subject, preheader, blocks, send_window_start, send_window_end, model, usage
    ) values (
      ${storeId}, ${job}, 'draft', ${brief.title}, ${brief.rationale}, ${audienceSql}, ${stats.count},
      ${productIds}::uuid[], ${brief.subject}, ${brief.preheader}, ${sql.json(blocks as never)},
      ${windowStart}, ${windowEnd}, ${usage.model}, ${sql.json(usageJson as never)}
    )
    returning *`;

  await audit(storeId, "ai", "brief.created", { type: "campaign_brief", id: row.id }, {
    job,
    audience_count: stats.count,
    model: usage.model,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_read_input_tokens: usage.cache_read_input_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens,
  });

  return row;
}
