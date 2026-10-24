import type { JSONContent } from "@maily-to/render";

/**
 * Variable contract shared by the editor, the renderer, the seed templates and
 * the send pipeline. This file must stay free of server-only imports because the
 * template editor (client component) reads it too.
 *
 * Maily semantics:
 *  - flat variables are rendered through `setVariableValues` (string map)
 *  - payload keys feed `repeat` blocks through `setPayloadValues` (arrays) and
 *    inside a repeat the item fields (title, image, ...) resolve as variables
 *  - flag payload keys (booleans) drive `showIfKey` on sections/buttons/etc.
 */

export type VariableKind = "string" | "array" | "flag";

export type ItemRow = Record<string, string>;

export type TemplateVariable = {
  name: string;
  description: string;
  kind: VariableKind;
  /** string for flat vars, rows for arrays, boolean for flags */
  sample: string | ItemRow[] | boolean;
};

export type StoreBrand = {
  name: string;
  brand_logo_url?: string | null;
};

const SAMPLE_SHOP_URL = "https://www.microsoft.com";
const SAMPLE_IMG = (label: string, bg: string) =>
  `https://placehold.co/480x600/${bg}/2b2b2b.png?text=${encodeURIComponent(label)}`;

const CART_ITEMS_SAMPLE: ItemRow[] = [
  {
    title: "Soft Jersey Hijab, Sand",
    image: SAMPLE_IMG("Jersey Hijab", "e9e1d6"),
    price: "$24.00",
    url: `${SAMPLE_SHOP_URL}/products/jersey-hijab-sand`,
    quantity: "2",
  },
  {
    title: "Linen Abaya, Stone",
    image: SAMPLE_IMG("Linen Abaya", "d9d4cc"),
    price: "$149.00",
    url: `${SAMPLE_SHOP_URL}/products/linen-abaya-stone`,
    quantity: "1",
  },
];

const RECOMMENDATIONS_SAMPLE: ItemRow[] = [
  {
    title: "Modal Underscarf, Ivory",
    image: SAMPLE_IMG("Underscarf", "efe9df"),
    price: "$14.00",
    url: `${SAMPLE_SHOP_URL}/products/modal-underscarf-ivory`,
    quantity: "1",
  },
  {
    title: "Chiffon Hijab, Mocha",
    image: SAMPLE_IMG("Chiffon Hijab", "cfc2b3"),
    price: "$28.00",
    url: `${SAMPLE_SHOP_URL}/products/chiffon-hijab-mocha`,
    quantity: "1",
  },
  {
    title: "Everyday Kimono, Charcoal",
    image: SAMPLE_IMG("Kimono", "c9c9c9"),
    price: "$89.00",
    url: `${SAMPLE_SHOP_URL}/products/everyday-kimono-charcoal`,
    quantity: "1",
  },
];

export const VARIABLES: TemplateVariable[] = [
  { name: "customer.first_name", description: "Customer first name (use a fallback such as 'there')", kind: "string", sample: "Amina" },
  { name: "customer.email", description: "Customer email address", kind: "string", sample: "amina@microsoft.com" },
  { name: "shop.name", description: "Store name", kind: "string", sample: "Zahriya" },
  { name: "shop.url", description: "Storefront URL", kind: "string", sample: SAMPLE_SHOP_URL },
  { name: "shop.logo_url", description: "Store logo image URL (blank when the store has none)", kind: "string", sample: "" },
  { name: "unsubscribe_url", description: "One-click unsubscribe link (required in every email)", kind: "string", sample: `${SAMPLE_SHOP_URL}/unsubscribe` },
  { name: "preferences_url", description: "Email preferences link", kind: "string", sample: `${SAMPLE_SHOP_URL}/preferences` },
  { name: "discount.code", description: "Discount code attached to the campaign", kind: "string", sample: "WELCOME10" },
  { name: "discount.percent", description: "Discount percentage, digits only", kind: "string", sample: "10" },
  { name: "cart.url", description: "Link back to the customer's abandoned checkout", kind: "string", sample: `${SAMPLE_SHOP_URL}/cart/recover` },
  { name: "cart_items", description: "Repeat block: items left in the cart (title, image, price, url, quantity)", kind: "array", sample: CART_ITEMS_SAMPLE },
  { name: "recommendations", description: "Repeat block: recommended products (title, image, price, url)", kind: "array", sample: RECOMMENDATIONS_SAMPLE },
  { name: "has_discount", description: "Flag: true when the campaign carries a discount code (use as 'show if' key)", kind: "flag", sample: true },
];

/** Fields available as variables inside a repeat block. */
export const ITEM_FIELDS: { name: string; description: string }[] = [
  { name: "title", description: "Product title" },
  { name: "image", description: "Product image URL" },
  { name: "price", description: "Formatted price" },
  { name: "url", description: "Product page URL" },
  { name: "quantity", description: "Quantity (cart items only)" },
];

export const ITEM_FIELD_NAMES = new Set(ITEM_FIELDS.map((f) => f.name));
export const FLAT_VARIABLE_NAMES = VARIABLES.filter((v) => v.kind === "string").map((v) => v.name);
export const PAYLOAD_KEYS = VARIABLES.filter((v) => v.kind !== "string").map((v) => v.name);

export type SampleContext = {
  variables: Record<string, string>;
  payloads: Record<string, ItemRow[] | boolean>;
};

/** Realistic payload for previews and test sends. */
export function sampleContext(store: StoreBrand, appUrl?: string): SampleContext {
  const variables: Record<string, string> = {};
  const payloads: Record<string, ItemRow[] | boolean> = {};
  for (const v of VARIABLES) {
    if (v.kind === "string") variables[v.name] = v.sample as string;
    else payloads[v.name] = v.sample as ItemRow[] | boolean;
  }
  variables["shop.name"] = store.name || (variables["shop.name"] as string);
  if (store.brand_logo_url) variables["shop.logo_url"] = store.brand_logo_url;
  if (appUrl) {
    const u = `${appUrl.replace(/\/$/, "")}/u/00000000-0000-0000-0000-000000000000`;
    variables["unsubscribe_url"] = u;
    variables["preferences_url"] = u;
  }
  return { variables, payloads };
}

/** Names of variables referenced by a Maily document (for templates.variables[]). */
export function collectVariables(doc: JSONContent): string[] {
  const found = new Set<string>();
  const strip = (s: string) => s.replace(/^https?:\/\//, "");

  const walk = (node: JSONContent) => {
    const attrs = (node.attrs ?? {}) as Record<string, unknown>;
    if (node.type === "variable" && typeof attrs.id === "string") found.add(attrs.id);
    if (node.type === "repeat" && typeof attrs.each === "string" && attrs.each) found.add(attrs.each);
    if (attrs.isUrlVariable && typeof attrs.url === "string") found.add(strip(attrs.url));
    if (attrs.isTextVariable && typeof attrs.text === "string") found.add(attrs.text);
    if (attrs.isSrcVariable && typeof attrs.src === "string") found.add(strip(attrs.src));
    if (attrs.isExternalLinkVariable && typeof attrs.externalLink === "string") found.add(strip(attrs.externalLink));
    if (typeof attrs.showIfKey === "string" && attrs.showIfKey) found.add(attrs.showIfKey);
    for (const mark of node.marks ?? []) {
      const m = (mark.attrs ?? {}) as Record<string, unknown>;
      if (mark.type === "link" && m.isUrlVariable && typeof m.href === "string") found.add(strip(m.href));
    }
    for (const child of node.content ?? []) walk(child);
  };
  walk(doc);

  return [...found].filter((n) => !ITEM_FIELD_NAMES.has(n)).sort();
}
