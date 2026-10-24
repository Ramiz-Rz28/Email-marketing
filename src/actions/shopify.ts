"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireStore } from "@/lib/auth";
import { audit, sql } from "@/lib/db";
import { JOBS, enqueue } from "@/lib/queue";
import { shopify } from "@/lib/shopify";

/** Start OAuth for the shop typed into the connect form. */
export async function connectShopify(formData: FormData) {
  await requireStore();
  const raw = String(formData.get("shop") ?? "").trim();
  const shop = shopify.utils.sanitizeShop(raw.includes(".") ? raw : `${raw}.myshopify.com`, true);
  if (!shop) redirect("/settings?error=invalid_shop");
  redirect(`/api/shopify/install?shop=${encodeURIComponent(shop)}`);
}

/** Mark the connection as removed. Tokens are wiped; mirrored data is kept. */
export async function disconnectShopify() {
  const { store, userId } = await requireStore();
  const rows = await sql<{ shop_domain: string }[]>`
    update shopify_connections
    set uninstalled_at = now(), access_token = '', webhook_ids = '[]'::jsonb
    where store_id = ${store.id} and uninstalled_at is null
    returning shop_domain`;
  if (rows[0]) {
    await audit(store.id, userId, "shopify.disconnected", { type: "shopify_connection", id: rows[0].shop_domain });
  }
  revalidatePath("/settings");
}

/** Re-run the full import (products, customers, orders). */
export async function triggerBackfill() {
  const { store, userId } = await requireStore();
  const rows = await sql<{ id: string }[]>`
    select id from shopify_connections where store_id = ${store.id} and uninstalled_at is null limit 1`;
  if (!rows[0]) return { ok: false as const, error: "No active Shopify connection" };
  await enqueue(JOBS.SHOPIFY_BACKFILL, { storeId: store.id });
  await audit(store.id, userId, "shopify.backfill_requested", { type: "shopify_connection", id: rows[0].id });
  revalidatePath("/settings");
  return { ok: true as const };
}
