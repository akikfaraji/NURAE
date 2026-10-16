# NURAE — CS Bot webhook error, and the promotional-mail system

**Date:** 2026-10-16 · rev `9cbe81b` + this session's work · Windows 11, Node 24, Next.js 16.3.4.
Every claim below is a command output, a file:line fact, or explicitly labelled as unverified.

---

## Part 1 — The bug you hit: `Bad Request: bad webhook: An HTTPS URL must be provided for webhook`

### What is actually happening

You started the official NURAE CS Bot with a valid token and AI key, running on `http://localhost:3000`.
The platform tried to register a **webhook** with Telegram, which accepts webhook URLs **only over
HTTPS** — it was handed `http://localhost:3000/api/telegram/webhook/<botId>` and refused.

The raw Telegram sentence reached your screen unchanged. That is the defect: NURAE *knew* the URL was not
HTTPS, let it through anyway, and relayed Telegram's rejection instead of doing the right thing (poll
locally) or saying exactly what to fix. Your token and AI key were never the problem — `getMe()` (the
token check) had already succeeded before the webhook call.

### Root cause — one exemption doing two jobs

`src/lib/nurae/runtime/transport.ts`, `validateWebhookUrl()` (before the fix):

```ts
if (parsed.protocol === 'https:') return null;
const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(parsed.hostname);
const hasApiOverride = Boolean(process.env.NURAE_TELEGRAM_API_BASE);
if (parsed.protocol === 'http:' && (isLocal || hasApiOverride)) return null;   // ← the bug
return 'Telegram webhooks require an HTTPS public URL. Set NURAE_PUBLIC_BASE_URL to your HTTPS origin.';
```

`isLocal` exists for the **mock Telegram server** used by the test suite and the split-E2E harness, where
plain HTTP is fine. Because it was written as `isLocal || hasApiOverride`, `http://localhost` also passed
validation against **real** Telegram. Chain: no `NURAE_PUBLIC_BASE_URL` → the origin is derived from the
request headers as `http://localhost:3000` → validation returns "fine" → `setWebhook` is called →
Telegram refuses → the catch block returns `err.message` verbatim.

### The fix (ready to apply — see the blocker at the end of this part)

**1. `validateWebhookUrl()` — the exemption becomes mock-only**

```ts
function validateWebhookUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Webhook base URL is not a valid URL.';
  }
  if (parsed.protocol === 'https:') return null;
  // Non-HTTPS can only work against a LOCAL MOCK Telegram API. Against real
  // Telegram every http:// URL is rejected — and relaying that rejection to
  // the owner is not an answer.
  if (parsed.protocol === 'http:' && process.env.NURAE_TELEGRAM_API_BASE) return null;
  return 'Telegram webhooks require an HTTPS public URL (Telegram rejects http:// webhook URLs).';
}
```

**Compatibility checked:** `tests/nurae/telegram-stub.ts:45` sets
`process.env.NURAE_TELEGRAM_API_BASE = TELEGRAM_STUB_BASE` (`http://127.0.0.1:39998`), so every
stub-driven webhook test keeps passing — the exemption still applies exactly where it was meant to.

**2. Two helpers next to `isServerless()`**

```ts
/** True when the transport was explicitly pinned via env. */
export function transportPinned(): boolean {
  const raw = (process.env.NURAE_BOT_TRANSPORT || '').trim().toLowerCase();
  return raw === 'polling' || raw === 'webhook';
}

/** Actionable next step — Telegram's raw text tells an owner nothing. */
export function webhookUrlHint(currentOrigin?: string | null): string {
  const origin = currentOrigin ? ` Current origin: ${currentOrigin}.` : '';
  return ' Telegram only accepts HTTPS webhook URLs.' + origin +
    ' Fix: set NURAE_PUBLIC_BASE_URL to a public HTTPS origin (your domain, or a tunnel such as cloudflared/ngrok) —' +
    ' or run the bot on this machine with NURAE_BOT_TRANSPORT=polling, which needs no public URL.';
}
```

**3. `startBot()` — decide before calling Telegram, not after**

Replace the top of the webhook branch (the lines that resolve `base`, build the URL and throw on
`urlError`) with this pre-flight, leaving the rest of the webhook block untouched from its
`const adapter = adapterFor(...)` line onward:

```ts
    let effectiveTransport: Transport = transport;
    if (effectiveTransport === 'webhook') {
      const base = opts?.publicBaseUrl ?? resolvePublicBaseUrl();
      if (!base) {
        throw new Error('No public base URL is available for webhook registration.' + webhookUrlHint(null));
      }
      const url = webhookUrlFor(base, botId);
      const urlError = validateWebhookUrl(url);
      if (urlError) {
        if (!transportPinned() && !isServerless()) {
          // Local, long-lived process with no HTTPS origin: poll instead of
          // bouncing Telegram's rejection back at the owner.
          effectiveTransport = 'polling';
          await log(
            botId,
            'warn',
            `${urlError} This is a local, long-lived process, so the bot starts on the polling transport instead (no public URL needed).`,
            'BOT_TRANSPORT_FALLBACK',
          );
        } else {
          throw new Error(urlError + webhookUrlHint(base));
        }
      }
    }

    if (effectiveTransport === 'webhook') {
      /* … the existing webhook block continues unchanged … */
```

Because the webhook block always `return`s, execution falls through to the existing polling branch when
`effectiveTransport` became `'polling'`.

**4. The catch block — never relay the raw sentence alone**

```ts
  } catch (err) {
    let detail =
      err instanceof TelegramApiError
        ? `Telegram rejected the request: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    if (/HTTPS URL must be provided/i.test(detail)) {
      detail += webhookUrlHint(opts?.publicBaseUrl ?? resolvePublicBaseUrl());
    }
    /* … existing updateMany + log + return … */
```

Net result: a local install self-heals onto polling with an honest log line; serverless still refuses to
pretend and now names the fix; Telegram's raw text is never the whole story again.

### What you can do right now, before the patch lands

Add this line to `NURAE/.env` and restart the server:

```
NURAE_BOT_TRANSPORT=polling
```

That is the documented local mode: it removes any webhook, verifies the token, and long-polls inside this
process — the CS bot then runs with no public URL. Keep it for local work; remove it (or set
`NURAE_PUBLIC_BASE_URL` to an HTTPS origin) when you deploy. On Vercel, polling is refused by design and
webhook is correct.

### Blocker — the workspace guard refuses these writes (your decision needed)

Three files that block real fixes cannot be written by an agent in this workspace. The guard
(`artifact_secret_detected`) rejects any write whose content contains a credential-shaped literal, and
these files legitimately contain their own domain vocabulary:

| File | Guard's report | What it is actually blocking |
| --- | --- | --- |
| `src/lib/nurae/runtime/transport.ts` | key name `token` at content line 143 | **this webhook fix** — the module exists to decrypt stored bot tokens, so it says `token` constantly |
| `src/lib/nurae/agents/platform-tools.ts` | key name `Token` at content line 102 | **the operator email tools** (Part 2) — the file's descriptions talk about bot tokens |
| `.env.example` | key name `Authorization` at content line 61 | documenting `NURAE_MAIL_DAILY_CAP`; lines 62/66 are **pre-existing** example lines |

The guard's own instruction is to surface a false positive to you rather than work around it, so I
stopped and did not attempt another route. **Your call: apply the patches by hand, or relax the guard for
these paths** (the same guard also blocks `src/lib/nurae/agents/tools.ts`, `src/lib/nurae/api/base.ts` and
`tests/nurae/helpers.ts`, which earlier blocked a security fix and a test-infra fix).

---

## Part 2 — The promotional-mail system: what is real today

You asked for a mailing system for promotions and for `/admin/agent` to be able to mail your logged-in
users. The blocker was real: the operator had **no email tool at all** and told you emailing users
"would need to be done outside of the NURAE platform" while NURAE already sends mail over Gmail SMTP.

### Built and VERIFIED

**Data model** (`prisma/schema.prisma`, client regenerated and probed at runtime):
`EmailCampaign`, `EmailDelivery`, `EmailSuppression`, `User.mailOptOutAt`.
`db.emailCampaign` / `db.emailDelivery` / `db.emailSuppression` all resolve — confirmed by a probe script.

**The engine** (`src/lib/nurae/email/campaigns.ts`, `suppression.ts`, `unsubscribe-token.ts`,
`src/app/api/email/unsubscribe/route.ts`), verified by `tests/nurae/campaigns.test.ts` — **15/15 pass**:

| Guarantee | Test that proves it |
| --- | --- |
| The audience is your own registered accounts, filtered by an explicit rule | verified/unverified deltas, `all_users`, `trial_users` |
| Suppressed and opted-out accounts are excluded, and counted | exclusion deltas per audience kind |
| A campaign can never mail the same address twice | second `queueCampaign` changes nothing; one row per (campaign, email) |
| Exclusions are re-checked at **send** time, not trusted from queue time | suppression added *after* queueing still blocks the send |
| An unconfigured transport loses nothing | rows stay `queued`, `skippedReason` says so, nothing "failed" |
| A real per-recipient error is recorded with the mailer's own text | row → `failed`, `detail` keeps the SMTP error, campaign `lastError` names the count |
| Unsubscribe links are unforgeable | round-trip, tampered payload, tampered signature, junk → null |
| An unsubscribe is GLOBAL | it reaches the invite funnel: the invite row is retired to `unsubscribed` |
| No full address ever reaches a display surface | campaign detail is masked |
| The cap is bounded | `mailDailyCap()` clamped; `campaignStats()` reports real numbers |

**Cross-subsystem integration:** `email/invites.ts` now consults the suppression list at opt-in, at send
time and for reminders, so an unsubscribe from a promotional mail also stops invitations.

**Regression state after all of this:** full suite **35 files pass (35)**, including the new
`campaigns.test.ts` (15 tests) and the earlier `readiness.test.ts`; `npx tsc --noEmit` is back at its
**pre-existing 61-error baseline** (I also fixed one real type error the engine had at
`campaigns.ts:349`). One full-suite run mid-session reported "2 failed | 33 passed" and two
subsequent runs were fully green — that matches the repo's documented cross-file flakiness (BR-033); I
could not reproduce it, so treat "green" as proven twice and "flaky under load" as a known open item.

### Written but NOT landed (guard-blocked)

The **operator tools** — six specs written against the verified engine: `email_audience_overview` (read),
`email_campaign_draft` (write), `email_campaign_send` (**consequential** — needs `confirm: true` plus
your approval, exactly like publishing a bot), `email_campaign_status` (read), `email_campaign_test`
(one test copy to your own inbox), `email_suppression_list` (read). They wire into
`platform-tools.ts`'s `PLATFORM_TOOLS` registry. The write was refused (table in Part 1), so the operator
still answers with the wrong "I can't do that" today.

### Not built at all

The **console**: `/admin/mail` page, its four admin API routes, the suppression-management route, the
client wrappers, and `campaigns-api.test.ts`. Nothing of that surface exists yet.

### The consent model (built in, not configurable)

The audience is always NURAE's registered accounts, selected by an explicit rule — addresses can never be
typed, imported, guessed or scraped into a campaign. Every mail carries a signed unsubscribe link; an
unsubscribe is permanent and global and no agent can undo it (only the human console can, deliberately).
`NURAE_MAIL_DAILY_CAP` — promotional mails per UTC day, default 150, ceiling 450, documented here because
`.env.example` cannot be written.

---

## Part 3 — "and more better things in here" — next for the operator surface

1. **Finish the operator tools** (written, blocked above) — this is the item you asked for by name.
2. **The `/admin/mail` console** — author, preview, test, send, watch per-recipient results.
3. **Scheduled campaigns** — "send this Tuesday 09:00", reusing the existing schedule ticker.
4. **Signed unsubscribe → preference centre** — "no promotions" vs "nothing at all".
5. **A capability map for the operator** — the root cause of your screenshot was the operator not knowing
   its own surface; a `platform_capabilities` tool means it can never again deny a capability it has.
6. **Automatic bounce suppression** — a hard bounce should suppress itself rather than be retried forever.

---

## Honest limits

- The webhook patch is **written but not applied** (guard) and therefore **not tested**; its suite
  compatibility is argued from `telegram-stub.ts:45`, a file fact, not a test run.
- The operator tools are **written but not applied, not compiled and not tested**.
- The mail engine is verified against an **injected fake transport** — no real mail was ever sent in this
  session, and the live Gmail path was not exercised.
- The console does not exist.
