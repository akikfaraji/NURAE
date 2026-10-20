# NURAE — Legal Documents (drafts)

**DRAFTS — TEMPLATES FOR LAWYER REVIEW. Nothing here is legal advice.**

Operator: **FRAZIYM TECH & AI** (Bangladesh) — entity registration in progress.

## Index

| Document | Purpose | Becomes |
|---|---|---|
| `terms-of-service.md` | The contract with account holders | `/terms` page + signup checkbox |
| `privacy-policy.md` | Data practices (GDPR-style) | `/privacy` page + footer |
| `refund-policy.md` | Credits, plans, Stars/crypto refunds | `/refunds` page + topup notice |
| `acceptable-use-policy.md` | Prohibited uses + enforcement | `/aup` page + signup checkbox |

## Placeholder convention

Replace every `[BRACKET]` before publishing:

- `[REGISTERED NAME]` — exact legal name once registered (e.g., "FRAZIYM TECH & AI" as sole proprietorship, or the Ltd. name). Until then keep as-is.
- `[BUSINESS ADDRESS]` — registered address (city, Bangladesh).
- `[SUPPORT EMAIL]` — e.g., support@…; `[ABUSE EMAIL]` — e.g., abuse@…
- `[GOVERNING COURTS]` — default: Dhaka, Bangladesh.
- `[EFFECTIVE DATE]`, `[VERSION]` — fill at publication; bump version on every material change.

## Pre-publication checklist

1. **Registration (Bangladesh):** trade license (city corporation / union parishad), TIN, BIN/VAT registration with NBR, business bank account. Revenues should land on the business, not a personal account.
2. **Lawyer review (Bangladesh + one global counsel for customer-facing terms):** confirm governing-law clause enforceability for foreign consumers, consumer-protection carve-outs (Bangladesh CPA 2009), and the crypto/FX posture (Bangladesh Bank guidance; FERA 1947).
3. **Crypto:** keep per-order/per-user caps and a written approvals runbook (see `../business/implementation-plan.md` §B); a lawyer should sign off on how crypto topups are described (usage credits, not investments).
4. **Stars:** confirm current Telegram Stars terms for bots (merchant of record, 21-day payout, refund mechanics via `refundStarPayment`).
5. **Copyright agent:** DMCA-style take-down contact (abuse email) even without US registration; state it in the AUP.
6. **After publication:** every topup flow must display the refund-policy notice; every signup must record acceptance of ToS+AUP with a version stamp; keep an archive of older versions (changing terms later requires notice under the ToS).

## Maintenance

- Re-review quarterly, and on any change to: payment rails, AI providers, data retention, features that process end-user data.
- Never publish markdown edits without bumping `[VERSION]` and saving the prior version.
