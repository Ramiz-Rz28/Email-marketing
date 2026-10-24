import { z } from "zod";

/**
 * Structured output contract for AI campaign briefs.
 *
 * The schema is sent to the Anthropic structured-output mode as JSON schema, which
 * rejects numeric/length/array-size keywords. Limits are therefore enforced with
 * `.refine()` (validated after the model answers, invisible to the JSON schema) and
 * described in `.describe()` so the model sees them.
 *
 * `blocks` is a union discriminated by `type` (z.union emits `anyOf`, which the API
 * supports; z.discriminatedUnion emits `oneOf`, which it may not).
 */

const maxLen = (n: number) => (s: string) => s.length <= n;

export const HeadingBlock = z.object({
  type: z.literal("heading"),
  text: z.string().describe("Heading text. May contain {{customer.first_name}}."),
});

export const ParagraphBlock = z.object({
  type: z.literal("paragraph"),
  text: z.string().describe("Body copy, 1-3 short sentences. May contain {{customer.first_name}}."),
});

export const ProductsBlock = z.object({
  type: z.literal("products"),
  source: z
    .enum(["cart_items", "recommendations", "explicit"])
    .describe("cart_items: the recipient's abandoned cart. recommendations: per-recipient picks. explicit: fixed product_ids."),
  product_ids: z
    .array(z.string())
    .optional()
    .describe("Only for source=explicit: ids copied from the candidate product list."),
  max: z.number().describe("How many products to show (1-4)."),
});

export const CtaBlock = z.object({
  type: z.literal("cta"),
  label: z.string().describe("Button label, 2-4 words."),
  url_var: z.enum(["cart.url", "shop.url"]),
});

export const DiscountBlock = z.object({
  type: z.literal("discount"),
  headline: z.string().describe("Short line shown above the code."),
  show_if_var: z.literal("discount.code"),
});

export const SpacerBlock = z.object({
  type: z.literal("spacer"),
});

export const BlockSchema = z.union([
  HeadingBlock,
  ParagraphBlock,
  ProductsBlock,
  CtaBlock,
  DiscountBlock,
  SpacerBlock,
]);
export type Block = z.infer<typeof BlockSchema>;

export const BlocksSchema = z
  .array(BlockSchema)
  .refine((b) => b.length >= 3 && b.length <= 7, { message: "blocks must contain 3 to 7 items" })
  .describe("3 to 7 blocks in display order.");

export const BriefSchema = z.object({
  title: z.string().describe("Internal campaign name for the merchant dashboard."),
  rationale: z
    .string()
    .describe("2-3 sentences: why now, who receives it, expected outcome."),
  subject: z
    .string()
    .refine(maxLen(60), { message: "subject must be at most 60 characters" })
    .describe("Email subject, at most 60 characters."),
  preheader: z
    .string()
    .refine(maxLen(90), { message: "preheader must be at most 90 characters" })
    .describe("Inbox preview text, at most 90 characters."),
  blocks: BlocksSchema,
  send_window_hours_from_now: z
    .object({
      start: z.number().describe("Earliest send, in hours from now."),
      end: z.number().describe("Latest send, in hours from now."),
    })
    .refine((w) => w.start >= 0 && w.end > w.start, { message: "send window end must be after start" }),
  discount_suggestion: z
    .object({
      percent: z.number().describe("Suggested percent off (5-20)."),
      reason: z.string(),
    })
    .nullable()
    .optional(),
  tone_check: z
    .string()
    .describe("One sentence confirming no pressure tactics and no fake scarcity or urgency."),
});

export type Brief = z.infer<typeof BriefSchema>;
