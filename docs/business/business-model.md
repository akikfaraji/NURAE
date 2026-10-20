# NURAE — Business Model

**Operator:** FRAZIYM TECH & AI (Bangladesh — entity registration in progress)
**Status:** functional MVP in production · October 2026
**Companions:** `implementation-plan.md` (what to build), `roadmap.md` (when), `../legal/` (documents)
**Disclaimer:** working plan, not legal or financial advice.

---

## 1. What NURAE is

A platform where non-technical people **describe an AI Telegram bot in plain English and get a real, hosted, running bot** — commands, buttons, workflows, AI answers, files/knowledge, broadcasts, payments (Stars), quizzes, giveaways, referral programs. The build loop is chat + agents (Bot Builder), with an audited tool layer; the operator runs an admin console and an official fleet of 5 growth bots.

The product is already the monetization backbone: a **pay-as-you-use wallet** (integer micro-dollars), free daily allowances, a 7-day trial, and optional plans — see `src/lib/nurae/billing/catalog.ts`, `plan-catalog.ts`.

## 2. Positioning

> Typical bot platforms charge **$10–$50/month whether you use it or not**. NURAE charges roughly **$1 per month of typical real usage** and gives free daily allowances on every feature. Free to start, pay for what you use, no lock-in, no DevOps.

- Telegram-native: payments via Telegram Stars, growth via Telegram communities themselves.
- BYOK-friendly: bring your own AI provider key and **AI replies are free** — NURAE still earns hosting, messages, builder rounds.
- "Chat is the interface. Agents are the workers. Tools are the hands." — the same engine powers the customer product, the fleet bots and the operator console.

## 3. Customers & segments (priority order)

| Priority | Segment | Pain | Wedge |
|---|---|---|---|
| 1 (now) | **Prosumer bot creators** — community admins, creators, small Telegram communities | Bots cost monthly subscriptions and code; usage is tiny most months | Free tier + $1-scale topups + bot templates (referral, giveaway, trivia, support) + official fleet as proof |
| 2 (next) | **SMBs** — support / sales bots for small businesses | Agency quotes are $500+; DIY is not an option | Bot Builder from a description + knowledge files + handoff to human |
| 3 (Phase 2) | **Agencies / resellers** | They rebuild the same platform per client | Per-tenant dashboard already exists (`/[slug]/dashboard`) → white-label tier |

## 4. The money model (as implemented)

### 4.1 Wallet
Every user has one balance in micro-dollars (1 µ$ = $0.000001; no float math, exact ledger). All topups and all usage flow through it. Balances are non-transferable prepaid credits, not money.

### 4.2 Feature price book (`src/lib/nurae/billing/catalog.ts`)

| Feature | Price | Free daily | Gate | Notes |
|---|---:|---:|---|---|
| `ai_reply` | $0.0015 / reply | 50 | skip silently | **Free with BYOK** |
| `ai_assistant` | $0.002 / turn | 25 | hard 402 | dashboard assistant (support chat is free — platform absorbs) |
| `ai_build` | $0.005 / round | 40 | hard 402 | one builder round ≈ 4–7 per complete build |
| `bot_message` | $0.00005 / msg | 500 | skip silently | $1 ≈ 20,000 messages |
| `broadcast_message` | $0.0001 / recipient | 0 | stop fan-out | |
| `hosting_day` | $0.01 / bot / day | 0 | stop after 3 unpaid days | nothing deleted |
| `file_upload_mb` | $0.002 / MB | 20 | hard 402 | extracted server-side for the AI |

UTC-midnight buckets. Operators can retune prices live (`api/admin/billing/grant`, admin price book).

### 4.3 Free-to-paid ladder
1. **7-day trial** — everything free (`TRIAL_DAYS`).
2. **Referral premium** — 2 premium days per qualified invite (`src/lib/nurae/referral.ts`), all usage free meanwhile.
3. **Free daily allowances** — forever, on every feature.
4. **Topups** when reality exceeds allowances.
5. **Plans** (wallet-funded, purely additive, 30 days):
   - Free $0 — baseline.
   - Plus $4.99/mo — every allowance ×3, hosting included for 3 running bots.
   - Pro $19.99/mo — ×10, hosting for 15 bots.

### 4.4 Payment rails
- **Telegram Stars** (primary): invoice via the official bot; `nurae_topup_<order>` payload; idempotent crediting. Credit rate **$0.014/Star** vs ≈$0.013/Star payout — the spread covers FX/payout timing; presets 50/100/250/500/1000 ★.
- **Crypto**: per-asset deposit addresses (TON, BTC, USDT-TRC20, ETH, LTC, TRX) with **manual tx-hash + admin approval**, plus optional **CryptoBot auto** rail (built, untested live).

## 5. Unit economics

### 5.1 Current COGS (why the model works today, and its hidden risk)
The platform currently runs almost entirely on **free AI tiers** (OpenRouter free models, OrcaRouter free models). Marginal COGS ≈ $0. **Do not build the plan on this**: free tiers can change TOS/rate limits overnight. Treat it as a launch-phase subsidy, not a moat.

### 5.2 Steady-state margins (paid-model mix assumed)

| Feature | Revenue | Est. cost | Margin |
|---|---:|---:|---:|
| `ai_reply` | $0.0015 | $0.0002–0.0008 (flash-class) | 45–85% |
| `ai_build` | $0.005 | $0.001–0.002 | 60–80% |
| `bot_message` | $0.00005 | ~$0.000002 (serverless) | ~95% |
| `hosting_day` | $0.01 | <$0.002 | ~80% |
| `file_upload_mb` | $0.002 | ~$0.00002 (storage) | ~99% |
| Stars topup | +$0.001/★ over payout | — | ~7% buffer |

Weighted blended margin target: **60–75%** once AI runs on paid fallbacks.

### 5.3 Example: one real community bot (≈1,000 end users)
- 3,000 bot messages, 1,000 AI replies, 30 hosting days, ~10 builder rounds.
- After free allowances: roughly $0.15 + $1.20 + $0.30 + ~$0.05 ≈ **~$1.70/month** revenue, COGS ~$0.50 → ~70% margin.
- The whale version (5k AI replies/day) is where plans + topups compound.

### 5.4 Fixed costs (current scale)
Serverless app + Postgres + domain + SMTP: **low tens of USD/month**. Breakeven at ~20–30 paying users; the constraint is founder time, not infra.

## 6. Growth loops (already in the codebase — keep them honest)

1. **Referral premium** — 2 free days per verified invite; every account has a `/?ref=CODE` link.
2. **Bot templates bake the owner's referral code** into instantiated bots (`bots/templates.ts`) — each customer bot is a distribution node.
3. **Official fleet** — 5 ownerless promotion bots (referral, giveaway, trivia, support, invite) with platform hooks (`auth/official-fleet.ts`, `runtime/fleet-posts.ts`).
4. **SEO / AI SEO** — `public/llms.txt` + marketing pages.
5. **Support chat is free** — retention/trust play; budget it as support cost (currently absorbed by the platform; see §7).

## 7. Risks & mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Free AI tiers vanish / rate-limit | High | Provider failover (openrouter→orca→BYOK), cost-capped paid fallback priced in §5.2, capture token COGS before that day |
| Referral farming (free premium) | High | Cap qualified rewards/month, disposable-email blocklist, min account age, payment-connected qualification later |
| Bangladesh regulatory/FX (crypto grey zone, FERA) | High | Register trade license/TIN/BIN; keep crypto ops capped, logged, isolated; lawyer + accountant review; evaluate foreign entity at ~$2k MRR |
| Manual crypto approvals = AML/ops burden | Medium | Hard caps per order/user/day, admin audit trail (exists), receipts; CryptoBot auto rail behind token |
| Telegram platform policy / Stars payout changes | Medium | Comply with Bot/Stars TOS; 21-day payout buffer baked into Stars credit rate; keep data exportable |
| Single-operator support load | Medium | Free support chat + fleet support bot + help docs; response-time expectations in ToS |
| Stars refund abuse | Low-Med | Use `refundStarPayment` deliberately (see refund policy); fraud forfeiture clause |

## 8. Recommendations (deltas to the current design)

1. **Cap the referral free-ride** (10 qualified/month, throwaway-email checks) — it is currently the most abusable perk.
2. **Receipts + dunning**: topup receipts, low-balance warning, plan-expiry and unpaid-hosting emails (SMTP exists) — cheapest churn reduction available.
3. **Refund tooling**: admin action that triggers `refundStarPayment` + wallet clawback for Stars orders.
4. **COGS instrumentation**: record estimated provider cost per AI call into the ledger meta before any paid-model switch; add margin view to admin dashboard.
5. **Agency/white-label tier** ($49–99/mo equivalent) as Phase 2 — the `[slug]` tenant surface is a head start.
6. **Entity**: register now (trade license, TIN, BIN) so revenues have a legal home; foreign entity decision at ~$2k MRR.
7. **Compliance minimum before paid marketing**: legal pages live + signup/topup acceptance + account delete/export + owner-DPA note (see implementation plan P0).

## 9. KPIs (admin dashboard targets)

- Signups/day; activation: **first bot published within 24h** (>30% target).
- Free→paid conversion within 30 days (>5% target; watch trial expiry + allowance exhaustion triggers).
- ARPPU and topup frequency; % of AI turns on BYOK (margin lever).
- COGS/revenue (<40% target); hosted-bot 30-day retention (>70%).
- Referral: K-factor, abuse-flag rate.
- Support cost per active user (absorbed; keep visible).
