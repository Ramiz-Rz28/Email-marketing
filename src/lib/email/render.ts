import { Maily, type JSONContent, type PayloadValue } from "@maily-to/render";

/**
 * Renders a stored Maily template (Tiptap JSON) into email HTML + plain text.
 * No DB or env access here so it can run in the worker, server actions and tests.
 */

export type RenderStore = {
  name: string;
  brand_logo_url?: string | null;
  brand_primary?: string | null;
  brand_font?: string | null;
};

export type RenderInput = {
  contentJson: JSONContent;
  subject: string;
  preheader: string;
  store: RenderStore;
  /** Flat variables: 'customer.first_name' -> 'Amina' */
  variables: Record<string, string>;
  /** Repeat-block arrays and show-if flags: 'cart_items' -> [{title,...}] */
  payloads?: Record<string, PayloadValue>;
};

export type RenderOutput = { html: string; subject: string; text: string };

type MailyTheme = Parameters<Maily["setTheme"]>[0];

// ---------------------------------------------------------------------------
// {{var}} replacement (subject + preheader). Supports {{name}} and {{name,fallback=x}}.
// ---------------------------------------------------------------------------
const TOKEN = /\{\{\s*([\w.]+)\s*(?:,\s*fallback\s*=\s*([^}]*?))?\s*\}\}/g;

export function renderSubject(subject: string, vars: Record<string, string>): string {
  return subject
    .replace(TOKEN, (_m, name: string, fallback?: string) => {
      const v = vars[name];
      return v !== undefined && v !== "" ? v : (fallback ?? "");
    })
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Brand theme
// ---------------------------------------------------------------------------
function parseHex(input: string | null | undefined): [number, number, number] | null {
  if (!input) return null;
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function luminance([r, g, b]: [number, number, number]): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

type FallbackFont = "serif" | "sans-serif" | "monospace";

function parseFont(brandFont: string | null | undefined): { family: string; fallback: FallbackFont } | null {
  if (!brandFont) return null;
  const parts = brandFont.split(",").map((p) => p.trim().replace(/^['"]|['"]$/g, ""));
  const family = parts[0];
  if (!family) return null;
  const rest = parts.slice(1).map((p) => p.toLowerCase());
  const fallback: FallbackFont = rest.includes("monospace")
    ? "monospace"
    : rest.includes("serif") && !rest.includes("sans-serif")
      ? "serif"
      : "sans-serif";
  return { family, fallback };
}

export function buildTheme(store: RenderStore): MailyTheme {
  const theme: Record<string, unknown> = {};
  const rgb = parseHex(store.brand_primary);
  if (rgb) {
    const hex = `#${rgb.map((n) => n.toString(16).padStart(2, "0")).join("")}`;
    const lum = luminance(rgb);
    theme.button = { backgroundColor: hex, color: lum > 0.55 ? "#111111" : "#ffffff" };
    // Only tint headings when the brand colour is dark enough to read on white.
    if (lum < 0.4) theme.colors = { heading: hex };
    theme.link = { color: lum < 0.5 ? hex : "#111827" };
  }
  const font = parseFont(store.brand_font);
  if (font && font.family.toLowerCase() !== "inter") {
    // Maily's default theme ships an Inter webFont; drop it for other families
    // so we never alias the Inter file under a different family name.
    theme.font = { fontFamily: font.family, fallbackFontFamily: font.fallback, webFont: undefined };
  }
  return theme as MailyTheme;
}

// ---------------------------------------------------------------------------
// Content preparation
// ---------------------------------------------------------------------------
function walk(node: JSONContent, fn: (n: JSONContent) => void) {
  fn(node);
  for (const c of node.content ?? []) walk(c, fn);
}

/** True when a footer node already links to {{unsubscribe_url}}. */
function hasUnsubscribeFooter(doc: JSONContent): boolean {
  let found = false;
  walk(doc, (n) => {
    if (n.type === "footer" && JSON.stringify(n).includes("unsubscribe_url")) found = true;
  });
  return found;
}

export function complianceFooterNode(storeName: string): JSONContent {
  return {
    type: "footer",
    attrs: { textAlign: "center" },
    content: [
      { type: "text", text: `${storeName}  ·  ` },
      {
        type: "text",
        text: "Unsubscribe",
        marks: [{ type: "link", attrs: { href: "unsubscribe_url", isUrlVariable: true } }],
      },
    ],
  };
}

/**
 * - guarantees a compliant footer
 * - replaces a logo bound to an empty variable with a text wordmark (no broken image)
 */
export function prepareContent(contentJson: JSONContent, store: RenderStore, vars: Record<string, string>): JSONContent {
  const doc: JSONContent =
    contentJson?.type === "doc" ? structuredClone(contentJson) : { type: "doc", content: structuredClone(contentJson?.content ?? []) };
  doc.content = doc.content ?? [];

  const swapEmptyLogos = (nodes: JSONContent[]): JSONContent[] =>
    nodes.map((n) => {
      const attrs = (n.attrs ?? {}) as Record<string, unknown>;
      if (n.type === "logo" && attrs.isSrcVariable && typeof attrs.src === "string") {
        const key = attrs.src.replace(/^https?:\/\//, "");
        if (!vars[key]) {
          return {
            type: "heading",
            attrs: { level: 3, textAlign: (attrs.alignment as string) ?? "center" },
            content: [{ type: "text", text: store.name }],
          };
        }
      }
      return n.content ? { ...n, content: swapEmptyLogos(n.content) } : n;
    });
  doc.content = swapEmptyLogos(doc.content);

  if (!hasUnsubscribeFooter(doc)) {
    doc.content.push({ type: "spacer", attrs: { height: 16 } });
    doc.content.push(complianceFooterNode(store.name));
  }
  return doc;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export async function renderTemplate(input: RenderInput): Promise<RenderOutput> {
  const { store, payloads = {} } = input;
  const vars: Record<string, string> = { "shop.name": store.name, ...input.variables };
  if (store.brand_logo_url && !vars["shop.logo_url"]) vars["shop.logo_url"] = store.brand_logo_url;

  const content = prepareContent(input.contentJson, store, vars);

  const build = () => {
    const maily = new Maily(content);
    maily.setTheme(buildTheme(store));
    const preview = renderSubject(input.preheader ?? "", vars);
    if (preview) maily.setPreviewText(preview);
    // Never leak "{{token}}" into a customer email: unresolved variables render as their fallback or "".
    maily.setVariableFormatter(({ fallback }) => fallback ?? "");
    // Only set non-empty values so a node-level fallback still applies to blanks.
    const flat: Record<string, string> = {};
    for (const [k, v] of Object.entries(vars)) if (v !== undefined && v !== null && v !== "") flat[k] = String(v);
    maily.setVariableValues(flat);
    maily.setPayloadValues(payloads);
    return maily;
  };

  const [html, text] = await Promise.all([build().render(), build().render({ plainText: true })]);
  return { html, text, subject: renderSubject(input.subject, vars) };
}
