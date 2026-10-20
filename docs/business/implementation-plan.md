# NURAE — Implementation Plan & TODO

Companions: `business-model.md` (why), `roadmap.md` (when), `../legal/` (documents).
Convention: **[P0]** = blocks taking real money / legal exposure · **[P1]** = launch quality · **[P2]** = growth.

---

## A. Legal & compliance go-live [P0]

- [ ] **Publish legal pages** — routes `/terms`, `/privacy`, `/refunds`, `/aup` rendering the canonical markdown from `docs/legal/*.md` (single source of truth; do not fork the text). Suggested wiring: `src/content/legal/` copies generated from `docs/legal/`, or read markdown at build.
- [ ] **Footer + auth links** — link all four pages from site footer and signup/login forms (`src/components/nurae/*`, `src/app/page.tsx`).
- [ ] **Acceptance capture** — checkbox "I agree to the Terms and Acceptable Use Policy" on signup; record `termsAcceptedAt` + version on `User` (Prisma migration). ToS version constant lives next to the markdown.
- [ ] **Topup acceptance** — short "digital credits, non-refundable except as stated → Refund Policy" notice with link on every topup flow (`billing` UI + Stars invoice description).
- [ ] **Refund tooling** — admin action: `refundStarPayment` (add to `src/lib/nurae/telegram/adapter.ts`) + wallet clawback/reversal ledger entry (idempotent), wired into admin billing orders UI (`src/app/api/admin/billing/orders`). Crypto: manual ledger adjustment only (already possible via `api/admin/billing/grant`).
- [ ] **Account delete + data export** — user-facing: export my data (JSON) and delete my account (anonymize ledger, delete bots/conversations/files). Prisma-aware cascade audit; keep financial ledger rows (legal retention) with pseudonymized user reference.
- [ ] **Bot-owner data note** — help page "Your bot, your data": owners are responsible for their end users' data; NURAE is a processor; offer a simple DPA text for business owners.
- [ ] **AI disclosure** — bots must be identifiable as AI where they answer with AI ("Powered by AI" in bot profile/about + first-contact hint), support chat header already implies it — make it explicit.
- [ ] **Age & sanctions basics** — 18+ gate on signup checkbox; deny signups/order processing from sanctioned regions list (env-driven list, admin-editable).

## B. Billing & payments hardening [P0]

- [ ] **Stars payout SOP** — connect the official bot to Fragment, document the 21-day withdrawal cycle, keep a monthly reconciliation sheet (Stars earned vs credited vs withdrawn). Ops doc in `docs/business/` mirror of this list.
- [ ] **Crypto caps** — per-order and per-user daily caps on manual crypto orders (env constants), duplicate-tx-hash rejection (exists?), and an admin runbook for approvals (check hash on-chain, credit, receipt). Add "crypto orders are final — no chargebacks possible" notice in the order UI.
- [ ] **CryptoBot auto rail** — live test the poller against @CryptoBot Pay sandbox/live before enabling; keep manual as default.
- [ ] **Referral anti-abuse** [P0] — max qualified rewards per inviter per month (default 10), disposable-domain blocklist, require ≥24h account age before qualification, flagging dashboard for admins. Files: `src/lib/nurae/referral.ts`, admin customers UI.
- [ ] **Plan lifecycle** [P1] — decide and implement: auto-renew opt-in (renew from wallet balance X days before expiry, `billing/plans.ts` + a cron beside `hosting.ts`), or keep manual with reminder emails. Whichever — never silently expire: email at 7/3/1 days.
- [ ] **Receipts & dunning emails** [P1] — topup receipt (Stars + crypto), low-balance threshold warning, unpaid-hosting warning before the 3-day stop (`billing/hosting.ts`), plan expiry. SMTP infra exists (`src/lib/nurae/email/*`).
- [ ] **Pricing display polish** [P1] — pricing page presents plans + the µ$ price book honestly; add "≈ how long $5 lasts" examples from real usage stats.

## C. Margin & control [P1]

- [ ] **COGS instrumentation** — capture estimated provider cost per AI call (tokens × provider price table) into ledger meta/log; report margin per feature in admin. Prereq for any paid-model fallback.
- [ ] **Provider failover** — `selectProvider` chain: openrouter → orca → user BYOK → capped paid fallback; degrade with honest errors, never silently spend unplanned money.
- [ ] **Admin revenue dashboard** — MRR-equivalent (topups + plans), active paying users, COGS estimate, margin, hosted bots, churn; extend `src/app/admin/dashboard`.

## D. Growth & product [P1→P2]

- [ ] **Template gallery page** — public `/templates` from `src/lib/nurae/bots/templates.ts` with "build this" CTA (bots instantiate with the visitor's referral code — loop already exists).
- [ ] **Onboarding checklist** — first-run: build a bot → test → publish; measure activation (first published bot ≤24h).
- [ ] **Help center** — `/help` expansion from `SETUP.md` + docs: BYOK guide, hosting/credits FAQ, bot-owner responsibilities page (see A).
- [ ] **Agency tier** [P2] — white-label `[slug]` polish: custom domains, per-tenant branding, team seats, invoice-style billing. Business case in `business-model.md` §8.
- [ ] **Card PSP rail** [P2] — evaluate Stripe/Paddle/LemonSqueezy availability for a Bangladesh-registered entity (likely requires foreign entity); keep Stars+crypto meanwhile.

## Verification & ops discipline (every item above)

- `node node_modules/typescript/bin/tsc --noEmit` — only the known pre-existing `.next/dev/types` noise allowed.
- `node node_modules/vitest/vitest.mjs run tests/nurae/<area>.test.ts` — extend tests with every billing/legal change (ledger idempotency, refund reversal, referral caps, delete/export).
- `node .axodex/run.cjs analyze --index-only` after merges; `impact <symbol>` before touching billing internals; `detect-changes --scope all` before commits.
- Never log secrets; crypto/Stars runbooks stay in ops docs, not code comments.

## Suggested build order

1. A: legal pages + acceptance + refund tool + delete/export (money can flow legally).
2. B: Stars payout SOP, crypto caps, referral anti-abuse (stop the bleeding points).
3. B/C P1: emails, plan lifecycle, COGS + admin dashboard (know your numbers).
4. D: templates gallery, onboarding, help center (grow).
5. P2: agency tier, PSP evaluation.
