import { NextResponse } from "next/server";
import { Webhook } from "svix";
import { env } from "@/lib/env";
import { enqueue, JOBS } from "@/lib/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Resend → Svix-signed webhook. Verify first, enqueue, return 200 fast.
 * Processing (sends/events/suppressions) happens in the worker: RESEND_EVENT.
 */
export async function POST(req: Request) {
  const secret = env().RESEND_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "webhook_not_configured" }, { status: 503 });

  const svixId = req.headers.get("svix-id");
  const svixTimestamp = req.headers.get("svix-timestamp");
  const svixSignature = req.headers.get("svix-signature");
  if (!svixId || !svixTimestamp || !svixSignature) {
    return NextResponse.json({ error: "missing_signature_headers" }, { status: 400 });
  }

  const rawBody = await req.text();
  let event: unknown;
  try {
    event = new Webhook(secret).verify(rawBody, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    });
  } catch {
    return NextResponse.json({ error: "invalid_signature" }, { status: 400 });
  }

  await enqueue(JOBS.RESEND_EVENT, { event, svixId }, { singletonKey: svixId });
  return NextResponse.json({ ok: true });
}
