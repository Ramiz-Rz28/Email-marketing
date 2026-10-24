import type { JSONContent } from "@maily-to/render";
import { sql } from "../db";
import { collectVariables } from "./variables";

/**
 * Global (store_id null) starter templates for the four lifecycle jobs.
 * Content is built programmatically as Maily/Tiptap JSON. Merchants duplicate
 * these into their own store before editing.
 *
 * Maily conventions used (verified against @maily-to/render 0.2.3):
 *  - variable node:   { type:'variable', attrs:{ id, fallback } }
 *  - repeat node:     { type:'repeat', attrs:{ each:'<payload key>' } }; inside it, variable ids
 *                     and `isUrlVariable`/`isSrcVariable` values resolve against the current item
 *  - url-bound attrs: store the variable NAME in url/src/href with the matching is*Variable flag
 */

type Part = string | JSONContent;

const MUTED = "#6f6a62";
const PAPER = "#f6f2ec";

// ---------------------------------------------------------------------------
// Node helpers
// ---------------------------------------------------------------------------
const text = (t: string, marks?: JSONContent["marks"]): JSONContent => ({ type: "text", text: t, ...(marks ? { marks } : {}) });

export const v = (id: string, fallback?: string, marks?: JSONContent["marks"]): JSONContent => ({
  type: "variable",
  attrs: { id, fallback: fallback ?? null, label: null, required: fallback === undefined, hideDefaultValue: false },
  ...(marks ? { marks } : {}),
});

const bold = [{ type: "bold" }];
const color = (c: string) => [{ type: "textStyle", attrs: { color: c } }];

const toInline = (parts: Part[]): JSONContent[] => parts.map((p) => (typeof p === "string" ? text(p) : p));

const p = (parts: Part | Part[], align: "left" | "center" = "left"): JSONContent => ({
  type: "paragraph",
  attrs: { textAlign: align },
  content: toInline(Array.isArray(parts) ? parts : [parts]),
});

const heading = (level: 1 | 2 | 3, parts: Part | Part[], align: "left" | "center" = "center"): JSONContent => ({
  type: "heading",
  attrs: { level, textAlign: align },
  content: toInline(Array.isArray(parts) ? parts : [parts]),
});

const logo = (): JSONContent => ({
  type: "logo",
  attrs: { src: "shop.logo_url", isSrcVariable: true, size: "md", alignment: "center" },
});

const spacer = (height = 24): JSONContent => ({ type: "spacer", attrs: { height } });
const divider = (): JSONContent => ({ type: "horizontalRule" });

const button = (label: string, urlVar: string): JSONContent => ({
  type: "button",
  attrs: {
    text: label,
    isTextVariable: false,
    url: urlVar,
    isUrlVariable: true,
    alignment: "center",
    variant: "filled",
    borderRadius: "sharp",
  },
});

const column = (width: number | "auto", content: JSONContent[], verticalAlign: "top" | "middle" = "middle"): JSONContent => ({
  type: "column",
  attrs: { width, verticalAlign },
  content,
});

/** Product row: image left, title / price / button right. Runs once per item inside a repeat. */
const productRow = (opts: { showQuantity: boolean; cta: string }): JSONContent => ({
  type: "columns",
  attrs: { gap: 16 },
  content: [
    column(36, [
      {
        type: "image",
        attrs: {
          src: "image",
          isSrcVariable: true,
          alt: "Product image",
          width: "auto",
          height: "auto",
          alignment: "left",
          externalLink: "url",
          isExternalLinkVariable: true,
        },
      },
    ]),
    column("auto", [
      p([v("title", "Your selection", bold)]),
      p(
        opts.showQuantity
          ? [v("price", "", color(MUTED)), text("  ·  Qty ", color(MUTED)), v("quantity", "1", color(MUTED))]
          : [v("price", "", color(MUTED))],
      ),
      button(opts.cta, "url"),
    ]),
  ],
});

const repeatOver = (each: string, row: JSONContent): JSONContent => ({
  type: "repeat",
  attrs: { each, isUpdatingKey: false, showIfKey: null },
  content: [row, spacer(16)],
});

/** Soft panel shown only when the campaign carries a discount (payload flag has_discount). */
const discountPanel = (): JSONContent => ({
  type: "section",
  attrs: {
    backgroundColor: PAPER,
    align: "center",
    borderWidth: 0,
    borderColor: PAPER,
    borderRadius: 0,
    marginTop: 8,
    marginRight: 0,
    marginBottom: 8,
    marginLeft: 0,
    paddingTop: 20,
    paddingRight: 20,
    paddingBottom: 12,
    paddingLeft: 20,
    showIfKey: "has_discount",
  },
  content: [
    p([text("Your code", color(MUTED))], "center"),
    heading(3, [v("discount.code", "")], "center"),
    p([v("discount.percent", ""), text("% off your next order", color(MUTED))], "center"),
  ],
});

const footer = (): JSONContent => ({
  type: "footer",
  attrs: { textAlign: "center" },
  content: [
    v("shop.name", "Our store"),
    text("  ·  "),
    {
      type: "text",
      text: "Unsubscribe",
      marks: [{ type: "link", attrs: { href: "unsubscribe_url", isUrlVariable: true } }],
    },
  ],
});

const doc = (...blocks: JSONContent[]): JSONContent => ({ type: "doc", content: blocks });

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------
type SeedTemplate = {
  kind: "cart_recovery" | "second_purchase" | "winback" | "affinity";
  name: string;
  subject: string;
  preheader: string;
  content: JSONContent;
};

export function buildSeedTemplates(): SeedTemplate[] {
  const greeting = (rest: string) => p([text("Hi "), v("customer.first_name", "there"), text(`, ${rest}`)]);

  return [
    {
      kind: "cart_recovery",
      name: "Cart recovery",
      subject: "Your bag is waiting, {{customer.first_name,fallback=friend}}",
      preheader: "The pieces you chose are still set aside for you.",
      content: doc(
        logo(),
        spacer(8),
        heading(2, "Still thinking it over?"),
        greeting("the pieces you chose are still waiting in your bag."),
        spacer(8),
        repeatOver("cart_items", productRow({ showQuantity: true, cta: "View piece" })),
        button("Return to your bag", "cart.url"),
        spacer(16),
        p([text("Questions about fit or fabric? Reply to this email and we will help.", color(MUTED))], "center"),
        divider(),
        footer(),
      ),
    },
    {
      kind: "second_purchase",
      name: "Second purchase",
      subject: "Pieces that pair well with your order",
      preheader: "A few considered additions, chosen to go with what you bought.",
      content: doc(
        logo(),
        spacer(8),
        heading(2, "Complete the look"),
        greeting("thank you for your order. These pieces sit well alongside it."),
        spacer(8),
        repeatOver("recommendations", productRow({ showQuantity: false, cta: "Shop now" })),
        button("Browse the collection", "shop.url"),
        spacer(16),
        divider(),
        footer(),
      ),
    },
    {
      kind: "winback",
      name: "Winback",
      subject: "It has been a while, {{customer.first_name,fallback=friend}}",
      preheader: "New arrivals, and something set aside for your return.",
      content: doc(
        logo(),
        spacer(8),
        heading(2, "We have missed you"),
        greeting("a lot has arrived since your last visit. Here is what we think you will like."),
        discountPanel(),
        spacer(8),
        repeatOver("recommendations", productRow({ showQuantity: false, cta: "View piece" })),
        button("Return to the store", "shop.url"),
        spacer(16),
        divider(),
        footer(),
      ),
    },
    {
      kind: "affinity",
      name: "New arrivals for you",
      subject: "New in, chosen for you",
      preheader: "Based on the pieces you return to most.",
      content: doc(
        logo(),
        spacer(8),
        heading(2, "Chosen for you"),
        greeting("these new arrivals are close to what you already love."),
        spacer(8),
        repeatOver("recommendations", productRow({ showQuantity: false, cta: "View piece" })),
        button("See all new arrivals", "shop.url"),
        spacer(16),
        divider(),
        footer(),
      ),
    },
  ];
}

/** Inserts any missing global templates. Returns the number inserted. */
export async function seedGlobalTemplates(): Promise<number> {
  let inserted = 0;
  for (const t of buildSeedTemplates()) {
    const existing = await sql<{ id: string }[]>`
      select id from templates where store_id is null and kind = ${t.kind} limit 1`;
    if (existing.length > 0) continue;
    const variables = collectVariables(t.content);
    await sql`
      insert into templates (store_id, name, kind, subject, preheader, content_json, variables)
      values (null, ${t.name}, ${t.kind}, ${t.subject}, ${t.preheader}, ${sql.json(t.content as never)}, ${sql.array(variables)})`;
    inserted += 1;
  }
  return inserted;
}
