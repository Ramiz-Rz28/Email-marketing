# email-marketing — project conventions

AI-operated lifecycle email marketing for Shopify (a simpler, approval-controlled Klaviyo).
Pilot store: Zahriya (zahriya.ca). Standalone web app, NOT a Shopify embedded app.

## Stack (do not swap)
- Next.js 16 App Router, TypeScript strict, `src/` dir, `@/*` alias.
- UI: **HeroUI v3** (`@heroui/react` + `@heroui/styles`, Tailwind v4). Compound components, `onPress`, semantic variants. Fetch docs with WebFetch: `https://heroui.com/docs/react/components/<slug>.mdx`. No HeroUI v2 patterns, no provider.
- Icons: `lucide-react`.
- Auth: Clerk. One Clerk **Organization == one store**. Server code resolves the tenant with `requireStore()` from `src/lib/auth.ts`.
- DB: Supabase Postgres via `postgres.js` (`sql` from `src/lib/db.ts`). Raw SQL, no ORM. Migrations are plain SQL in `supabase/migrations/NNNN_*.sql`, applied by `npm run db:migrate`.
- Queue/cron: **pg-boss** (`src/lib/queue.ts`). Job names only from `JOBS`. Handlers register in `src/jobs/<module>.ts`.
- Email editor: **Maily** (`@maily-to/core` Editor, `@maily-to/render` render). Templates are Tiptap `JSONContent` in `templates.content_json`.
- Delivery: **Resend** (`src/lib/resend.ts`), batch endpoint, Svix-signed webhooks.
- Shopify: `@shopify/shopify-api` v15 (`src/lib/shopify.ts`). OAuth offline token, app-specific webhooks, Bulk Operations for backfill.
- AI: Anthropic SDK with **prompt caching** (`src/lib/ai/client.ts`). Use `generateStructured()` with a zod schema; stable context in cached `system` blocks, per-call data in `user`. `fast` tier for copy, `smart` tier for planning.

## Hard rules (product guardrails)
1. Only `customers.marketing_state = 'subscribed'` with a non-null email may receive marketing.
2. Suppressions (`suppressions`) and the per-store weekly frequency cap are checked **at send time** in the worker, after approval. AI output can never bypass them.
3. Nothing reaches a customer without a `campaign_briefs.status = 'approved'` row (or an explicit manual send). Write to `audit_log` for every approval/send/template change.
4. AI never receives raw PII tables. It gets aggregates, product catalog digest, and anonymised audience stats.
5. `campaign_briefs.audience_sql` is executed only through `runAudienceQuery()` (read-only tx, validated).

## Code conventions
- Server components by default; `"use client"` only for interactive leaves.
- Server actions live in `src/actions/*.ts` and start with `const { store, userId } = await requireStore()`.
- Route handlers: `src/app/api/**/route.ts`. Webhooks verify signature first, enqueue to pg-boss, return 200 fast.
- Every tenant query filters by `store_id`. Prefer `sql\`...\`` tagged templates; `sql.unsafe` only for validated dynamic SQL.
- Money is `numeric(12,2)` → read as string from postgres.js; convert with `Number()` at the edge.
- Do not edit `package.json` from feature work; list needed deps in your report.
- Keep files small; no barrel re-exports except `src/jobs/index.ts`.

## Layout
```
src/app/(auth)        Clerk sign-in/up
src/app/(app)         merchant dashboard (layout with sidebar)
src/app/api/shopify   OAuth install/callback
src/app/api/webhooks  shopify/, resend/
src/app/u             public unsubscribe/preferences
src/lib               env, db, auth, queue, shopify, resend, ai/, email/, lifecycle/, shopify/
src/jobs              pg-boss handlers per module
worker/index.ts       Railway worker service entry
scripts/              migrate, seed
supabase/migrations   SQL
```

## Deploy (Railway, two services from this repo)
- `web`: build `npm run build`, start `npm start` (PORT provided).
- `worker`: start `npm run worker`.
- Both need the same env (see `.env.example`). Run `npm run db:migrate` once per deploy (web pre-deploy command).
