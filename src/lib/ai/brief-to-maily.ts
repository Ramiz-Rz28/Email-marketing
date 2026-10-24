import type { JSONContent } from "@maily-to/render";
import { getStoreById, sql, audit, type StoreRow } from "../db";
import { BlocksSchema, type Block, type Brief } from "./brief-schema";
import type { BriefRow } from "./briefs";

/**
 * Converts a brief's `blocks[]` into Maily (Tiptap) JSONContent.
 *
 * Node names/attrs verified against @maily-to/core 0.3.7 (extensions d.ts) and the
 * @maily-to/render 0.2 renderer: logo, heading, paragraph, variable, button, spacer, section
 * (showIfKey), columns/column, image (isSrcVariable), repeat (each, showIfKey), footer,
 * horizontalRule, link mark (isUrlVariable).
 *
 * Send-time contract for the email worker (variables are rendered by Maily):
 *  - top-level values:  customer.first_name, cart.url, shop.url, discount.code, unsubscribe_url
 *  - repeat payloads:   `cart_items` and `recommendations` are arrays of
 *                       { title, price, url, image_url } (price pre-formatted). Slice each to
 *                       the block's `max` (stored as attrs.max on the repeat node).
 *  - discount section is hidden unless `discount.code` is set (showIfKey).
 */

export type MailyProduct = {
  id: string;
  title: string;
  image_url: string | null;
  url: string | null;
  price_min: string | null;
  price_max: string | null;
};

type StoreBrand = Pick<StoreRow, "name" | "brand_logo_url" | "brand_primary">;

const ALLOWED_INLINE_VARS = new Map<string, string>([["customer.first_name", "there"]]);
const VAR_RE = /\{\{\s*([A-Za-z0-9_.]+)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g;

/** Splits copy into text + variable nodes. Unknown {{tokens}} are dropped so they never leak to customers. */
function inline(text: string): JSONContent[] {
  const out: JSONContent[] = [];
  let last = 0;
  const push = (t: string) => {
    const clean = t.replace(/\{\{|\}\}/g, "");
    if (clean) out.push({ type: "text", text: clean });
  };
  for (const m of text.matchAll(VAR_RE)) {
    const idx = m.index ?? 0;
    push(text.slice(last, idx));
    const id = m[1];
    if (ALLOWED_INLINE_VARS.has(id)) {
      out.push({ type: "variable", attrs: { id, fallback: m[2] || ALLOWED_INLINE_VARS.get(id) } });
    }
    last = idx + m[0].length;
  }
  push(text.slice(last));
  return out;
}

const variable = (id: string, fallback = ""): JSONContent => ({ type: "variable", attrs: { id, fallback } });

const paragraph = (content: JSONContent[], align: "left" | "center" = "left"): JSONContent => ({
  type: "paragraph",
  attrs: { textAlign: align },
  ...(content.length > 0 ? { content } : {}),
});

const heading = (content: JSONContent[], level: 1 | 2 | 3, align: "left" | "center" = "left"): JSONContent => ({
  type: "heading",
  attrs: { level, textAlign: align },
  content,
});

function button(
  text: string,
  url: string,
  isUrlVariable: boolean,
  brand: StoreBrand,
  alignment: "left" | "center" = "center",
): JSONContent {
  return {
    type: "button",
    attrs: {
      text,
      isTextVariable: false,
      url,
      isUrlVariable,
      alignment,
      variant: "filled",
      borderRadius: "smooth",
      buttonColor: brand.brand_primary || "#111111",
      textColor: "#ffffff",
      paddingTop: 10,
      paddingRight: 28,
      paddingBottom: 10,
      paddingLeft: 28,
    },
  };
}

function productColumns(imageSrc: string | null, isSrcVariable: boolean, body: JSONContent[]): JSONContent {
  const columns: JSONContent[] = [];
  if (imageSrc) {
    columns.push({
      type: "column",
      attrs: { width: 35, verticalAlign: "middle" },
      content: [
        {
          type: "image",
          attrs: { src: imageSrc, isSrcVariable, alt: "", width: "auto", height: "auto", alignment: "center" },
        },
      ],
    });
  }
  columns.push({
    type: "column",
    attrs: { width: imageSrc ? 65 : 100, verticalAlign: "middle" },
    content: body,
  });
  return { type: "columns", attrs: { gap: 12 }, content: columns };
}

const priceText = (p: MailyProduct): string => {
  const lo = p.price_min ?? p.price_max;
  const hi = p.price_max ?? p.price_min;
  if (lo == null || hi == null) return "";
  const a = Number(lo).toFixed(2);
  const b = Number(hi).toFixed(2);
  return a === b ? `$${a}` : `$${a} - $${b}`;
};

function productsNode(
  block: Extract<Block, { type: "products" }>,
  brand: StoreBrand,
  products: Map<string, MailyProduct>,
): JSONContent[] {
  if (block.source === "explicit") {
    const picked = (block.product_ids ?? [])
      .map((id) => products.get(id))
      .filter((p): p is MailyProduct => Boolean(p))
      .slice(0, Math.max(1, Math.round(block.max) || 4));
    return picked.map((p) => {
      const body: JSONContent[] = [heading([{ type: "text", text: p.title }], 3)];
      const price = priceText(p);
      if (price) body.push(paragraph([{ type: "text", text: price }]));
      if (p.url) body.push(button("Shop now", p.url, false, brand, "left"));
      return productColumns(p.image_url, false, body);
    });
  }

  const each = block.source; // 'cart_items' | 'recommendations'
  const body: JSONContent[] = [
    heading([variable("title")], 3),
    paragraph([variable("price")]),
    button("Shop now", "url", true, brand, "left"),
  ];
  return [
    {
      type: "repeat",
      attrs: { each, isUpdatingKey: false, showIfKey: "", max: Math.max(1, Math.round(block.max) || 4) },
      content: [productColumns("image_url", true, body)],
    },
  ];
}

export function briefToMailyJson(
  brief: Pick<Brief, "blocks">,
  store: StoreBrand,
  products: MailyProduct[] = [],
): JSONContent {
  const byId = new Map(products.map((p) => [p.id, p]));
  const content: JSONContent[] = [];

  if (store.brand_logo_url) {
    content.push({ type: "logo", attrs: { src: store.brand_logo_url, size: "md", alignment: "center" } });
  }

  let headingCount = 0;
  for (const block of brief.blocks) {
    switch (block.type) {
      case "heading": {
        const c = inline(block.text);
        if (c.length === 0) break;
        content.push(heading(c, headingCount === 0 ? 1 : 2));
        headingCount += 1;
        break;
      }
      case "paragraph": {
        const c = inline(block.text);
        if (c.length > 0) content.push(paragraph(c));
        break;
      }
      case "products":
        content.push(...productsNode(block, store, byId));
        break;
      case "cta":
        content.push(button(block.label, block.url_var, true, store));
        break;
      case "discount": {
        const c = inline(block.headline);
        content.push({
          type: "section",
          attrs: {
            showIfKey: block.show_if_var,
            align: "center",
            backgroundColor: "#f7f7f7",
            borderWidth: 1,
            borderColor: "#e2e2e2",
            borderRadius: 6,
            marginTop: 0,
            marginRight: 0,
            marginBottom: 20,
            marginLeft: 0,
            paddingTop: 16,
            paddingRight: 16,
            paddingBottom: 16,
            paddingLeft: 16,
          },
          content: [
            paragraph(c, "center"),
            {
              type: "paragraph",
              attrs: { textAlign: "center" },
              content: [{ ...variable(block.show_if_var), marks: [{ type: "bold" }] }],
            },
          ],
        });
        break;
      }
      case "spacer":
        content.push({ type: "spacer", attrs: { height: 24 } });
        break;
    }
  }

  content.push({ type: "horizontalRule" });
  content.push({
    type: "footer",
    attrs: { textAlign: "center" },
    content: [
      { type: "text", text: `You are receiving this email because you subscribed to ${store.name}. ` },
      {
        type: "text",
        text: "Unsubscribe",
        marks: [{ type: "link", attrs: { href: "unsubscribe_url", isUrlVariable: true } }],
      },
    ],
  });

  return { type: "doc", content };
}

/** Collects the variable / payload keys a document references (stored in templates.variables). */
export function extractTemplateVariables(doc: JSONContent): string[] {
  const found = new Set<string>();
  const walk = (n: JSONContent) => {
    const a = (n.attrs ?? {}) as Record<string, unknown>;
    if (n.type === "variable" && typeof a.id === "string") found.add(a.id);
    if (n.type === "button" && a.isUrlVariable === true && typeof a.url === "string") found.add(a.url);
    if (n.type === "repeat" && typeof a.each === "string" && a.each) found.add(a.each);
    if (typeof a.showIfKey === "string" && a.showIfKey) found.add(a.showIfKey);
    for (const m of n.marks ?? []) {
      const ma = (m.attrs ?? {}) as Record<string, unknown>;
      if (m.type === "link" && ma.isUrlVariable === true && typeof ma.href === "string") found.add(ma.href);
    }
    for (const c of n.content ?? []) walk(c);
  };
  walk(doc);
  return [...found].sort();
}

/**
 * Renders the brief into a store-scoped template and links it on the brief. If the brief
 * already has a template it is re-rendered in place (used after copy edits).
 */
export async function createTemplateFromBrief(
  briefId: string,
  opts: { storeId?: string; actor?: string } = {},
): Promise<string> {
  const scope = opts.storeId ? sql`and store_id = ${opts.storeId}` : sql``;
  const [brief] = await sql<BriefRow[]>`select * from campaign_briefs where id = ${briefId} ${scope} limit 1`;
  if (!brief) throw new Error("brief not found");

  const parsed = BlocksSchema.safeParse(brief.blocks);
  if (!parsed.success) throw new Error(`brief ${briefId} has invalid blocks: ${parsed.error.message}`);
  const blocks = parsed.data;

  const store = await getStoreById(brief.store_id);
  if (!store) throw new Error("store not found");

  const wanted = new Set<string>(brief.product_ids ?? []);
  for (const b of blocks) if (b.type === "products") for (const id of b.product_ids ?? []) wanted.add(id);
  const products =
    wanted.size === 0
      ? []
      : await sql<MailyProduct[]>`
          select id::text as id, title, image_url, url, price_min::text as price_min, price_max::text as price_max
          from products
          where store_id = ${brief.store_id} and id = any(${[...wanted]}::uuid[])`;

  const doc = briefToMailyJson({ blocks }, store, products);
  const variables = extractTemplateVariables(doc);
  const kind = ["cart_recovery", "second_purchase", "winback", "affinity"].includes(brief.lifecycle_job)
    ? brief.lifecycle_job
    : "custom";

  const { templateId, created } = await sql.begin(async (tx) => {
    if (brief.template_id) {
      const upd = await tx`
        update templates
        set name = ${brief.title}, kind = ${kind}, subject = ${brief.subject}, preheader = ${brief.preheader},
            content_json = ${tx.json(doc as never)}, variables = ${variables}::text[], preview_html = null
        where id = ${brief.template_id} and store_id = ${brief.store_id}
        returning id`;
      if (upd.length > 0) return { templateId: brief.template_id, created: false };
    }
    const [row] = await tx<{ id: string }[]>`
      insert into templates (store_id, name, kind, subject, preheader, content_json, variables)
      values (${brief.store_id}, ${brief.title}, ${kind}, ${brief.subject}, ${brief.preheader},
              ${tx.json(doc as never)}, ${variables}::text[])
      returning id`;
    await tx`update campaign_briefs set template_id = ${row.id} where id = ${brief.id} and store_id = ${brief.store_id}`;
    return { templateId: row.id, created: true };
  });

  await audit(
    brief.store_id,
    opts.actor ?? "ai",
    created ? "template.created" : "template.updated",
    { type: "template", id: templateId },
    { brief_id: brief.id },
  );
  return templateId;
}
