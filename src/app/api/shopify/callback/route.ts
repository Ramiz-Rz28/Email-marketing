import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { getStoreOrNull } from "@/lib/auth";
import { audit, sql } from "@/lib/db";
import { JOBS, enqueue } from "@/lib/queue";
import { shopify } from "@/lib/shopify";
import { gql, type ShopifyConn } from "@/lib/shopify/bulk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COOKIE = "shopify_oauth";

const WEBHOOK_TOPICS = [
  "ORDERS_CREATE",
  "ORDERS_UPDATED",
  "CUSTOMERS_CREATE",
  "CUSTOMERS_UPDATE",
  "CUSTOMERS_EMAIL_MARKETING_CONSENT_UPDATE",
  "CHECKOUTS_CREATE",
  "CHECKOUTS_UPDATE",
  "PRODUCTS_CREATE",
  "PRODUCTS_UPDATE",
  "APP_UNINSTALLED",
] as const;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Shopify OAuth query HMAC: hex sha256 over sorted `k=v` pairs (hmac removed) joined with &. */
function verifyQueryHmac(params: URLSearchParams, secret: string): boolean {
  const provided = params.get("hmac");
  if (!provided) return false;
  const message = [...params.entries()]
    .filter(([k]) => k !== "hmac")
    .map(([k, v]) => [k.replace(/%/g, "%25").replace(/&/g, "%26").replace(/=/g, "%3D"), v.replace(/%/g, "%25").replace(/&/g, "%26")] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const expected = createHmac("sha256", secret).update(message).digest("hex");
  return safeEqual(expected, provided.toLowerCase());
}

/** Cookie format: `${nonce}.${storeId}.${hmacHex}`. Returns the parts if the signature is valid. */
function readStateCookie(raw: string | undefined, secret: string): { nonce: string; storeId: string } | null {
  if (!raw) return null;
  const [nonce, storeId, sig] = raw.split(".");
  if (!nonce || !storeId || !sig) return null;
  const expected = createHmac("sha256", secret).update(`${nonce}.${storeId}`).digest("hex");
  return safeEqual(expected, sig) ? { nonce, storeId } : null;
}

type ExistingHook = { id: string; topic: string; endpoint: { callbackUrl?: string } | null };

async function registerWebhooks(conn: ShopifyConn, callbackUrl: string): Promise<string[]> {
  const existing = await gql<{ webhookSubscriptions: { nodes: ExistingHook[] } }>(
    conn,
    `query { webhookSubscriptions(first: 100) { nodes { id topic endpoint { ... on WebhookHttpEndpoint { callbackUrl } } } } }`,
  );
  const have = new Map<string, string>();
  for (const n of existing.webhookSubscriptions.nodes) {
    if (n.endpoint?.callbackUrl === callbackUrl) have.set(n.topic, n.id);
  }

  const ids: string[] = [];
  for (const topic of WEBHOOK_TOPICS) {
    const found = have.get(topic);
    if (found) {
      ids.push(found);
      continue;
    }
    try {
      const data = await gql<{
        webhookSubscriptionCreate: {
          webhookSubscription: { id: string } | null;
          userErrors: { field?: string[]; message: string }[];
        };
      }>(
        conn,
        `mutation Sub($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
           webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
             webhookSubscription { id }
             userErrors { field message }
           }
         }`,
        { topic, sub: { callbackUrl, format: "JSON" } },
      );
      const r = data.webhookSubscriptionCreate;
      if (r.webhookSubscription) ids.push(r.webhookSubscription.id);
      else console.error(`[shopify] webhook ${topic} not created: ${r.userErrors.map((e) => e.message).join("; ")}`);
    } catch (err) {
      console.error(`[shopify] webhook ${topic} failed`, err);
    }
  }
  return ids;
}

export async function GET(req: NextRequest) {
  const { SHOPIFY_API_KEY, SHOPIFY_API_SECRET, NEXT_PUBLIC_APP_URL } = env();
  const fail = (code: string, status = 400) => {
    const res = NextResponse.redirect(new URL(`/settings?error=${code}`, NEXT_PUBLIC_APP_URL));
    res.cookies.delete({ name: COOKIE, path: "/api/shopify" });
    return status === 400 ? res : NextResponse.json({ error: code }, { status });
  };

  if (!SHOPIFY_API_KEY || !SHOPIFY_API_SECRET) return fail("not_configured", 500);

  const params = req.nextUrl.searchParams;
  if (!verifyQueryHmac(params, SHOPIFY_API_SECRET)) return fail("bad_hmac");

  const shop = shopify.utils.sanitizeShop(params.get("shop") ?? "", true);
  const code = params.get("code");
  const state = params.get("state");
  if (!shop || !code || !state) return fail("bad_request");

  const cookie = readStateCookie(req.cookies.get(COOKIE)?.value, SHOPIFY_API_SECRET);
  if (!cookie || !safeEqual(cookie.nonce, state)) return fail("bad_state");

  const ctx = await getStoreOrNull();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (ctx.store.id !== cookie.storeId) return fail("store_mismatch");
  const storeId = ctx.store.id;

  // Exchange the code for an offline access token.
  const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: SHOPIFY_API_KEY, client_secret: SHOPIFY_API_SECRET, code }),
  });
  if (!tokenRes.ok) return fail("token_exchange_failed");
  const token = (await tokenRes.json()) as { access_token?: string; scope?: string };
  if (!token.access_token) return fail("token_exchange_failed");
  const scopes = token.scope ?? "";

  // Upsert the connection (one per store; shop_domain is globally unique).
  try {
    await sql`
      insert into shopify_connections (store_id, shop_domain, access_token, scopes)
      values (${storeId}, ${shop}, ${token.access_token}, ${scopes})
      on conflict (store_id) do update set
        shop_domain    = excluded.shop_domain,
        access_token   = excluded.access_token,
        scopes         = excluded.scopes,
        installed_at   = now(),
        uninstalled_at = null`;
  } catch (err) {
    console.error("[shopify] connection upsert failed", err);
    return fail("shop_in_use");
  }

  // App webhooks → our receiver. Failures are logged but don't block the connection.
  const conn: ShopifyConn = { shop_domain: shop, access_token: token.access_token, scopes };
  let webhookIds: string[] = [];
  try {
    webhookIds = await registerWebhooks(conn, `${NEXT_PUBLIC_APP_URL}/api/webhooks/shopify`);
  } catch (err) {
    console.error("[shopify] webhook registration failed", err);
  }
  await sql`
    update shopify_connections set webhook_ids = ${sql.json(webhookIds as never)}
    where store_id = ${storeId}`;

  await audit(storeId, ctx.userId, "shopify.connected", { type: "shopify_connection", id: shop }, {
    shop,
    scopes,
    webhooks: webhookIds.length,
  });
  await enqueue(JOBS.SHOPIFY_BACKFILL, { storeId });

  const res = NextResponse.redirect(new URL("/settings?connected=1", NEXT_PUBLIC_APP_URL));
  res.cookies.delete({ name: COOKIE, path: "/api/shopify" });
  return res;
}
