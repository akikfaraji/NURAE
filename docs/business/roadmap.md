# NURAE — Roadmap

Operator: FRAZIYM TECH & AI (Bangladesh) · Updated Oct 2026
Companions: `business-model.md`, `implementation-plan.md`, `../legal/`.

---

## Phase 0 — Take money legally (Oct–Nov 2026)

**Goal:** every dollar that arrives has a legal home, a receipt, and a refund path.

Delivery:
- [ ] FRAZIYM TECH & AI registered: trade license, TIN, BIN (NBR), business bank account. (Do this in parallel with everything.)
- [ ] Legal pages live + acceptance captured (implementation plan A).
- [ ] Refund tooling live (Stars refund via API + wallet reversal).
- [ ] Crypto order caps + approval runbook; Stars payout SOP (Fragment, 21-day cycle).
- [ ] Referral anti-abuse caps.
- [ ] Account delete + data export.

Gate to Phase 1: a stranger can sign up, top up with Stars or crypto, use the platform, get a receipt, request a refund, and delete their account — all without founder intervention.

**Metrics:** zero unhandled billing disputes; ≥1 real external paying user; payout reconciliation up to date.

---

## Phase 1 — Public launch (Dec 2026 – Feb 2027)

**Goal:** controlled public release around the free tier and the templates.

Delivery:
- [ ] Onboarding checklist + activation metric; trial expiring prompts.
- [ ] Receipts/dunning emails (low balance, plan expiry, unpaid hosting).
- [ ] Template gallery `/templates` (instantiate with referral code).
- [ ] Help center: BYOK guide, credits FAQ, bot-owner responsibilities.
- [ ] Admin revenue dashboard (topups, plans, COGS estimate, margin).
- [ ] COGS instrumentation + provider failover chain.
- [ ] Launch push: Product Hunt/Reddit/Telegram communities; fleet bots posting; llms.txt/SEO refresh.

Gate to Phase 2: ≥100 activated accounts (first bot published), free→paid ≥3%, COGS visibility live.

**Metrics:** activations, free→paid, ARPPU, K-factor, 30-day hosted-bot retention.

---

## Phase 2 — Monetize the middle (Mar – Jun 2027)

**Goal:** turn prosumer traction into SMB/agency revenue; add a card rail if entity allows.

Delivery:
- [ ] Agency/white-label tier (custom domains, per-tenant branding, team seats) — price anchor $49–99/mo equivalent; reuses `[slug]` tenants.
- [ ] White-label billing: tenants get their own Stars invoices with a platform share.
- [ ] Plan auto-renew (opt-in) + annual prepay discount (2 months free) if data supports.
- [ ] PSP evaluation for cards (Stripe/Paddle/LemonSqueezy) — may require foreign entity; decide based on volume and Bangladesh constraints.
- [ ] Template marketplace pilot: top 5 community templates authored by users, revenue share in credits.
- [ ] Uptime/status page + basic SLA language for business tier.

Gate to Phase 3: MRR-equivalent ≥ $2k; agency tier ≥ 10 tenants; churn < 5%/mo.

**Metrics:** MRR-equivalent, agency MRR, margin %, churn, support load per account.

---

## Phase 3 — Scale & optionality (H2 2027)

**Goal:** choose the next shape from data: product-led scale vs. B2B platform.

Options (pick by evidence):
- [ ] Product-led: consumer marketing engine on top of templates + fleet viral loops; premium templates.
- [ ] Platform: public API + MCP tooling for third-party builders; per-call platform fees.
- [ ] Vertical packs (support, education, community monetization) sold as bundles.
- [ ] Entity/location decision revisit: foreign operating company at scale for payouts/FX/banking.
- [ ] Consider raised capital only against a proven B2B motion.

---

## Standing workstreams (every phase)

- Compliance: refresh legal docs each quarter or on new rails/features; accountant reviews VAT/income treatment (Stars = Telegram merchant-of-record; crypto self-assessed).
- Security: dependency updates, secret rotation, admin audit review.
- Reliability: provider failover, DB backups verified, restore drill twice a year.
- Cost: monthly margin review; retune price book via admin if provider pricing moves.
- Customer voice: every banned/edge case feeds the AUP and help center.

## Risks to watch (from business-model.md §7)

Free AI tier dependency · referral farming · Bangladesh crypto/FX regulation · Telegram policy changes · single-operator bandwidth. Each phase gate is a natural re-checkpoint.
