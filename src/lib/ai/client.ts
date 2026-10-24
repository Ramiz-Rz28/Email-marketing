import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { env } from "../env";

/**
 * Anthropic client with prompt caching baked in.
 *
 * Cost model: every call puts the STABLE context (product rules, output contract,
 * store brand/catalog digest) in `system` blocks marked `cache_control: ephemeral`.
 * Only the small per-call request goes in `messages`. Repeated calls within the
 * cache TTL pay ~10% for the cached prefix. The store digest is rebuilt at most
 * once per nightly scoring run so it stays byte-identical between calls.
 *
 * Tiering: `fast` (Haiku 5.5) for copy/drafting; `smart` (Sonnet 5.5) for planning.
 * Structured output uses the native `output_config.format` JSON-schema mode.
 */

declare global {
  // eslint-disable-next-line no-var
  var __anthropic: Anthropic | undefined;
}

export const anthropic: Anthropic =
  globalThis.__anthropic ?? new Anthropic({ apiKey: env().ANTHROPIC_API_KEY || "placeholder", maxRetries: 2 });
if (process.env.NODE_ENV !== "production") globalThis.__anthropic = anthropic;

export type Tier = "fast" | "smart";
export const modelFor = (tier: Tier) => (tier === "fast" ? env().AI_MODEL_FAST : env().AI_MODEL_SMART);

export type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  model: string;
};

export type SystemBlock = { text: string; cache?: boolean };

function toSystem(blocks: SystemBlock[]): Anthropic.TextBlockParam[] {
  return blocks.map((b) => ({
    type: "text",
    text: b.text,
    ...(b.cache ? { cache_control: { type: "ephemeral" as const } } : {}),
  }));
}

function toUsage(model: string, u: Anthropic.Usage): Usage {
  return {
    model,
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
  };
}

function textOf(res: Anthropic.Message): string {
  return res.content
    .filter((c): c is Anthropic.TextBlock => c.type === "text")
    .map((c) => c.text)
    .join("");
}

/**
 * Structured output: the zod schema is sent as a JSON schema output format, so the
 * model must return matching JSON. Re-validated with zod before returning.
 */
export async function generateStructured<T extends z.ZodTypeAny>(opts: {
  tier: Tier;
  system: SystemBlock[];
  user: string;
  schema: T;
  maxTokens?: number;
  effort?: "low" | "medium" | "high";
}): Promise<{ data: z.infer<T>; usage: Usage }> {
  const model = modelFor(opts.tier);
  const jsonSchema = z.toJSONSchema(opts.schema, { target: "draft-2020-12" }) as Record<string, unknown>;

  const res = await anthropic.messages.create({
    model,
    max_tokens: opts.maxTokens ?? 2048,
    system: toSystem(opts.system),
    output_config: {
      effort: opts.effort ?? (opts.tier === "fast" ? "low" : "medium"),
      format: { type: "json_schema", schema: jsonSchema },
    },
    messages: [{ role: "user", content: opts.user }],
  });

  const raw = textOf(res);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Model returned non-JSON output: ${raw.slice(0, 200)}`);
  }
  const data = opts.schema.parse(parsed);
  return { data, usage: toUsage(model, res.usage) };
}

/** Plain text generation (subject lines, short copy). */
export async function generateText(opts: {
  tier: Tier;
  system: SystemBlock[];
  user: string;
  maxTokens?: number;
  effort?: "low" | "medium" | "high";
}): Promise<{ text: string; usage: Usage }> {
  const model = modelFor(opts.tier);
  const res = await anthropic.messages.create({
    model,
    max_tokens: opts.maxTokens ?? 512,
    system: toSystem(opts.system),
    output_config: { effort: opts.effort ?? "low" },
    messages: [{ role: "user", content: opts.user }],
  });
  return { text: textOf(res), usage: toUsage(model, res.usage) };
}

/** Rough USD estimate for dashboards (per-million-token list prices; adjust as needed). */
export function estimateCostUsd(u: Usage): number {
  const isFast = u.model.includes("haiku");
  const inPrice = isFast ? 1 : 3;
  const outPrice = isFast ? 5 : 15;
  const write = u.cache_creation_input_tokens * 1.25;
  const read = u.cache_read_input_tokens * 0.1;
  return ((u.input_tokens + write + read) * inPrice + u.output_tokens * outPrice) / 1_000_000;
}
