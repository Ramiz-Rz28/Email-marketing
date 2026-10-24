import { sql } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ctx = { params: Promise<{ sendId: string }> };

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function page(title: string, body: string, status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f2ec;color:#1f1d1a;
font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}main{max-width:420px;padding:32px;text-align:center}
h1{font-size:22px;font-weight:600;margin:0 0 8px}p{margin:0;color:#6f6a62}</style></head>
<body><main><h1>${esc(title)}</h1><p>${body}</p></main></body></html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

/** Idempotent. Returns the store name on success, null when the send is unknown. */
async function unsubscribe(sendId: string): Promise<string | null> {
  if (!UUID.test(sendId)) return null;
  const rows = await sql<
    { store_id: string; customer_id: string; campaign_id: string; email: string; store_name: string }[]
  >`
    select s.store_id, s.customer_id, s.campaign_id, s.email, st.name as store_name
    from sends s join stores st on st.id = s.store_id
    where s.id = ${sendId} limit 1`;
  const send = rows[0];
  if (!send) return null;

  const changed = await sql`
    update customers set marketing_state = 'unsubscribed', consent_updated_at = now()
    where id = ${send.customer_id} and store_id = ${send.store_id} and marketing_state <> 'unsubscribed'`;
  if (changed.count > 0) {
    await sql`insert into consent_events (store_id, customer_id, state, source, raw)
              values (${send.store_id}, ${send.customer_id}, 'unsubscribed', 'unsubscribe_link',
                      ${sql.json({ send_id: sendId, campaign_id: send.campaign_id } as never)})`;
  }
  await sql`insert into suppressions (store_id, email, reason, source)
            values (${send.store_id}, ${send.email}, 'unsubscribed', 'unsubscribe_link')
            on conflict (store_id, email) do nothing`;
  await sql`insert into events (store_id, customer_id, type, campaign_id, props, dedupe_key)
            values (${send.store_id}, ${send.customer_id}, 'unsubscribed', ${send.campaign_id},
                    ${sql.json({ send_id: sendId } as never)}, ${`unsub:${sendId}`})
            on conflict (store_id, dedupe_key) do nothing`;
  return send.store_name;
}

export async function GET(_req: Request, { params }: Ctx) {
  const { sendId } = await params;
  const store = await unsubscribe(sendId);
  if (store === null) return page("Link not recognised", "This unsubscribe link is invalid or has expired.", 404);
  return page("You are unsubscribed", `You will no longer receive marketing emails from ${esc(store)}.`);
}

/** RFC 8058 one-click: mail clients POST `List-Unsubscribe=One-Click`. */
export async function POST(_req: Request, { params }: Ctx) {
  const { sendId } = await params;
  const store = await unsubscribe(sendId);
  if (store === null) return new Response("not found", { status: 404 });
  return new Response("ok", { status: 200, headers: { "cache-control": "no-store" } });
}
