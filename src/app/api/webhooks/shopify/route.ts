import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { sql } from "@/lib/db";
import { JOBS, enqueue } from "@/lib/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function validHmac(rawBody: string, header: string | null, secret: string): boolean {
  if (!header || !secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(header, "base64");
  } catch {
    return false;
  }
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/** Verify signature first, enqueue, return 200 fast. Processing happens in the worker. */
export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  if (!validHmac(rawBody, req.headers.get("x-shopify-hmac-sha256"), env().SHOPIFY_API_SECRET)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  const topic = req.headers.get("x-shopify-topic");
  const shopDomain = req.headers.get("x-shopify-shop-domain")?.toLowerCase();
  const webhookId = req.headers.get("x-shopify-webhook-id");
  if (!topic || !shopDomain) return NextResponse.json({ error: "missing headers" }, { status: 400 });

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const rows = await sql<{ store_id: string }[]>`
    select store_id from shopify_connections where shop_domain = ${shopDomain} limit 1`;
  const storeId = rows[0]?.store_id;
  // Unknown shop: acknowledge so Shopify doesn't keep retrying/removing the subscription.
  if (!storeId) return NextResponse.json({ ok: true, ignored: true });

  await enqueue(
    JOBS.SHOPIFY_WEBHOOK,
    { storeId, topic, shopDomain, payload },
    webhookId ? { singletonKey: webhookId } : {},
  );
  return NextResponse.json({ ok: true });
}
