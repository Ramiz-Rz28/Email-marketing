// fetch + WebCrypto based adapter: works on Node 22 (Railway worker) and Cloudflare Workers alike.
import "@shopify/shopify-api/adapters/web-api";
import { shopifyApi, ApiVersion, LogSeverity, Session } from "@shopify/shopify-api";
import { env } from "./env";

/**
 * Shopify SDK configured for a STANDALONE (non-embedded) app that merchants
 * connect from our own dashboard via OAuth. Offline tokens are stored in
 * shopify_connections. Webhooks are app-specific (declared in shopify.app.toml)
 * so the only webhook helper we need is `shopify.webhooks.validate`.
 */
declare global {
  // eslint-disable-next-line no-var
  var __shopify: ReturnType<typeof shopifyApi> | undefined;
}

function pickApiVersion(v: string): ApiVersion {
  const match = (Object.values(ApiVersion) as string[]).find((x) => x === v);
  return (match as ApiVersion | undefined) ?? ApiVersion.July26;
}

export const shopify =
  globalThis.__shopify ??
  shopifyApi({
    apiKey: env().SHOPIFY_API_KEY || "placeholder",
    apiSecretKey: env().SHOPIFY_API_SECRET || "placeholder",
    scopes: env().SHOPIFY_SCOPES.split(",").map((s) => s.trim()),
    hostName: new URL(env().NEXT_PUBLIC_APP_URL).host,
    hostScheme: new URL(env().NEXT_PUBLIC_APP_URL).protocol.replace(":", "") as "http" | "https",
    apiVersion: pickApiVersion(env().SHOPIFY_API_VERSION),
    isEmbeddedApp: false,
    logger: { level: env().NODE_ENV === "production" ? LogSeverity.Warning : LogSeverity.Info },
  });
if (process.env.NODE_ENV !== "production") globalThis.__shopify = shopify;

/** Build an offline Session from a stored connection so we can call the Admin API. */
export function sessionFor(shopDomain: string, accessToken: string, scopes: string): Session {
  return new Session({
    id: `offline_${shopDomain}`,
    shop: shopDomain,
    state: "",
    isOnline: false,
    accessToken,
    scope: scopes,
  });
}

export function adminGraphql(shopDomain: string, accessToken: string, scopes: string) {
  return new shopify.clients.Graphql({ session: sessionFor(shopDomain, accessToken, scopes) });
}

/** Normalise "gid://shopify/Product/123" → "123" when needed for URLs. */
export const gidToId = (gid: string) => gid.split("/").pop() ?? gid;
