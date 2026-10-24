/**
 * Runtime detection + Cloudflare binding access that is safe to import from
 * code that also runs in the plain-Node worker on Railway.
 *
 * On Cloudflare Workers (OpenNext) `getCloudflareContext()` returns the env with
 * bindings; anywhere else it throws, and we fall back to process.env.
 */
export type CfBindings = {
  HYPERDRIVE?: { connectionString: string };
  [key: string]: unknown;
};

let cached: CfBindings | undefined;

export function cloudflareEnv(): CfBindings | null {
  if (cached) return cached;
  try {
    // Lazy require so the Node worker never loads the OpenNext runtime.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("@opennextjs/cloudflare") as { getCloudflareContext: () => { env: CfBindings } };
    const env = mod.getCloudflareContext().env;
    if (env) cached = env; // only cache a hit: outside a request context this throws and we retry next call
    return env ?? null;
  } catch {
    return null;
  }
}

/** True when running inside a Cloudflare Worker isolate (no long-lived process, no timers across requests). */
export function isCloudflareWorker(): boolean {
  // OpenNext sets this; the Workers runtime also exposes a distinctive navigator.userAgent.
  return (
    cloudflareEnv() !== null ||
    (typeof navigator !== "undefined" && typeof navigator.userAgent === "string" && navigator.userAgent.includes("Cloudflare-Workers"))
  );
}
