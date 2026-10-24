# email-marketing

AI-operated lifecycle email marketing for Shopify stores — a simpler, approval-controlled alternative to Klaviyo.
Pilot store: **Zahriya** (zahriya.ca).

The AI analyses first-party Shopify signals, drafts a small number of high-quality campaign **briefs**
(who, what, when, why), and nothing reaches a customer until a merchant **approves**. Consent,
suppressions and frequency caps are enforced server-side at send time regardless of what the AI drafted.

## Stack

| Layer | Choice | Why |
|---|---|---|
| App | Next.js 16 (App Router) + TypeScript | one codebase for dashboard + API |
| UI | HeroUI v3 (Tailwind v4) | premium components, zero custom primitives |
| Auth | Clerk (Organizations) | one org = one store; no auth code to write |
| DB | Supabase Postgres (raw SQL via postgres.js) | RFM/scoring in SQL, no ORM overhead |
| Jobs | pg-boss | queue + cron on Postgres, no Redis |
| Email editor | Maily (`@maily-to/core` / `render`) | open-source block editor → client-safe HTML |
| Delivery | Resend | batch API + webhooks |
| Shopify | `@shopify/shopify-api` | OAuth, HMAC, Admin GraphQL, Bulk Operations |
| AI | Anthropic SDK, **prompt caching** | stable store digest + rules cached; per-call data small |
| Hosting | Railway (web + worker) | long-running Node for jobs |

## Local setup

```bash
cp .env.example .env         # fill Clerk, Supabase, Shopify, Resend, Anthropic
npm install
npm run db:migrate           # applies supabase/migrations/*.sql
npm run db:seed              # 4 global lifecycle templates
npm run dev                  # web on :3000
npm run worker:dev           # pg-boss worker (separate terminal)
```

Sign in, create an Organization (= your store), go to **Settings → Connect Shopify**.
The install flow registers webhooks and starts a Bulk Operations backfill (products, customers, 2y orders).

## How a campaign happens

```
Shopify webhooks/backfill ─▶ customers · orders · events
        nightly cron ─▶ refresh_customer_scores (RFM, churn, reorder date)
                     ─▶ 4 lifecycle jobs build candidate audiences
                     ─▶ AI brief (cached system prompt + store digest) ─▶ campaign_briefs(draft)
        merchant ─▶ Approvals page ─▶ approve
        worker ─▶ campaign.send ─▶ consent + suppression + frequency check ─▶ Resend batch
        Resend webhooks ─▶ delivered/opened/clicked/bounced ─▶ suppressions, attribution (last click 7d)
```

Lifecycle jobs in V1: **cart recovery**, **second purchase**, **win-back / replenishment**, **product affinity**.

## Prompt caching

`src/lib/ai/client.ts` puts stable content in `system` blocks marked `cache_control: ephemeral`:
1. product rules + output contract (never changes)
2. the store digest (`getStoreDigest`) — deterministic text rebuilt at most hourly
3. a short per-job playbook

Only audience stats and candidate products go in the user message. `campaign_briefs.usage` records
`cache_read_input_tokens` so cost per brief is visible. Haiku handles copy, Sonnet handles planning.

## Deploy on Railway

Two services from this repo, same env vars:

- **web** — build `npm run build`, pre-deploy `npm run db:migrate`, start `npm start`
- **worker** — start `npm run worker`

Set `NEXT_PUBLIC_APP_URL` to the web service's public URL; Shopify redirect URL is
`{APP_URL}/api/shopify/callback`, Resend webhook is `{APP_URL}/api/webhooks/resend`.

## Guardrails (non-negotiable)

- Only `marketing_state = 'subscribed'` customers with an email are ever targeted.
- `suppressions` and the weekly per-customer cap are re-checked at send time.
- Every approval, send and template change is written to `audit_log`.
- The AI never sees raw customer PII — aggregates and catalog only.
- AI-produced `audience_sql` runs only through `runAudienceQuery()` (validated, read-only, 15s timeout).
