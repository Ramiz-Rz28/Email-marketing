import { createHmac, randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { getStoreOrNull } from "@/lib/auth";
import { shopify } from "@/lib/shopify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COOKIE = "shopify_oauth";

/**
 * Begin Shopify OAuth (offline token). State = random nonce; the cookie binds the
 * nonce to the signed-in store and is HMAC-signed so it can't be forged.
 */
export async function GET(req: NextRequest) {
  const ctx = await getStoreOrNull();
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const shop = shopify.utils.sanitizeShop(req.nextUrl.searchParams.get("shop") ?? "", true);
  if (!shop) return NextResponse.json({ error: "invalid shop domain" }, { status: 400 });

  const { SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SHOPIFY_SCOPES, NEXT_PUBLIC_APP_URL, NODE_ENV } = env();
  if (!SHOPIFY_API_KEY || !SHOPIFY_API_SECRET) {
    return NextResponse.json({ error: "Shopify app credentials are not configured" }, { status: 500 });
  }

  const nonce = randomBytes(16).toString("hex");
  const payload = `${nonce}.${ctx.store.id}`;
  const sig = createHmac("sha256", SHOPIFY_API_SECRET).update(payload).digest("hex");

  const authorize = new URL(`https://${shop}/admin/oauth/authorize`);
  authorize.searchParams.set("client_id", SHOPIFY_API_KEY);
  authorize.searchParams.set("scope", SHOPIFY_SCOPES.split(",").map((s) => s.trim()).filter(Boolean).join(","));
  authorize.searchParams.set("redirect_uri", `${NEXT_PUBLIC_APP_URL}/api/shopify/callback`);
  authorize.searchParams.set("state", nonce);
  // Offline access is the default when no per-user grant option is requested.

  const res = NextResponse.redirect(authorize.toString());
  res.cookies.set(COOKIE, `${payload}.${sig}`, {
    httpOnly: true,
    secure: NODE_ENV === "production",
    sameSite: "lax", // must survive the top-level redirect back from Shopify
    path: "/api/shopify",
    maxAge: 10 * 60,
  });
  return res;
}
