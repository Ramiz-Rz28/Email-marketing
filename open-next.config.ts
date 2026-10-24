import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// No incremental cache: every dashboard route is dynamic (per-tenant, auth-gated),
// so there is nothing for ISR/R2 to cache. Add r2IncrementalCache if static pages appear.
export default defineCloudflareConfig({});
