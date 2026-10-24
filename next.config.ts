import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Keep Node-native packages out of the Next bundler on both Railway and Cloudflare (nodejs_compat).
  serverExternalPackages: ["pg-boss", "postgres", "@shopify/shopify-api", "@maily-to/render"],
  // OpenNext copies only traced files; these packages resolve different entry points under the
  // Workers `workerd` export condition, so include them whole.
  outputFileTracingIncludes: {
    "/**": [
      "./node_modules/jose/**/*",
      "./node_modules/pg-cloudflare/**/*",
      "./node_modules/@react-email/render/**/*",
      "./node_modules/@maily-to/render/**/*",
    ],
  },
  experimental: {
    serverActions: { bodySizeLimit: "4mb" },
  },
};

export default nextConfig;

// Exposes Cloudflare bindings (Hyperdrive etc.) to `next dev` via getCloudflareContext(). No-op elsewhere.
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
initOpenNextCloudflareForDev();
