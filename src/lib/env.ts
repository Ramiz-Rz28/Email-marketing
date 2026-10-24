import { z } from "zod";

/**
 * Server-side environment. Validated once at import time.
 * Only import from server code (route handlers, server actions, worker).
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),

  CLERK_SECRET_KEY: z.string().min(1),

  DATABASE_URL: z.string().min(1),
  DATABASE_DIRECT_URL: z.string().min(1).optional(),

  SHOPIFY_API_KEY: z.string().default(""),
  SHOPIFY_API_SECRET: z.string().default(""),
  SHOPIFY_SCOPES: z
    .string()
    .default("read_customers,read_orders,read_all_orders,read_products,read_checkouts,write_discounts"),
  SHOPIFY_API_VERSION: z.string().default("2026-07"),

  RESEND_API_KEY: z.string().default(""),
  RESEND_WEBHOOK_SECRET: z.string().default(""),
  RESEND_FROM_DEFAULT: z.string().default("Store <hello@microsoft.com>"),

  ANTHROPIC_API_KEY: z.string().default(""),
  AI_MODEL_FAST: z.string().default("claude-haiku-5-5"),
  AI_MODEL_SMART: z.string().default("claude-sonnet-5-5"),

  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(4),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ");
    throw new Error(`Invalid environment:\n  ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export const isProd = () => env().NODE_ENV === "production";
