# NURAE — Bug Reports & Fixes

A running log of every bug reported during live testing, with the diagnosed
root cause, the shipped fix, and current status. Newest entries are added at
the bottom. The technical work log lives in [`worklog.md`](./worklog.md);
this file is the user-facing history of what broke and how it was resolved.

| ID | Reported symptom | Root cause | Fix | Status |
|----|------------------|------------|-----|--------|
| BR-001 | Registering a new account says "failed to verify"; verification mail never arrives | `setup.sh` reused a stale build/running server after `git pull` (no `/api/auth/verify` in the old process), and when Gmail SMTP failed the register UI still claimed the code was sent | Stale-build detection + stale-server replacement in `setup.sh`; register now returns an actionable mail error (`mailFailureHint`), verify step shows "email could not be sent" + Resend button; app-password whitespace stripped | FIXED — V00.01.010 |
| BR-002 | Official NURAE CS bot: cannot configure API keys or system prompt | Bots created before the provider rework carried `provider='zai'` (removed), so the key field didn't render; config dialog was buried | Legacy zai rows auto-migrate to openrouter at boot; "Configure keys & prompt" button directly on the Official Bot card (API key, Telegram token, prompt, model); "Reset prompt to official" + official CS prompt shipped | FIXED — V00.01.010 |
| BR-003 | Telegram shows AI output with raw markdown — `#`, `*` appear literally | Replies were sent with no `parse_mode`, and Telegram renders plain text as-is | New dependency-free markdown → Telegram-HTML converter (headings→bold, `**`/`_`→bold/italic, code→`<code>`/`<pre>`, links, lists, quotes, tables), replies sent with `parse_mode=HTML`; long replies chunked ≤4096; if Telegram rejects the HTML the raw text is resent plain so the reply always arrives | FIXED — V00.01.011 |
| BR-004 | OTP mail never reaches any inbox; log shows `connect ENETUNREACH 2404:6800:…:465` | The device's network has no IPv6 route, but DNS answered `smtp.gmail.com` with an AAAA record first and nodemailer dialed it — connection unreachable. The app password itself was valid all along | IPv4-first DNS order forced in the mailer module (`dns.setDefaultResultOrder('ipv4first')`); ENETUNREACH-specific setup hint added; live SMTP delivery test passed (Gmail `250 OK`) with the owner's credentials | FIXED — V00.01.011 |
| BR-005 | Dev log spams `A Node.js module is loaded ('node:dns') which is not supported in the Edge Runtime` on every request | `src/instrumentation.ts` is compiled for BOTH the Node and Edge runtime targets in dev; the IPv4 DNS fix placed there tripped Turbopack's static analysis on every compile | Node-only DNS side effect moved back into `src/lib/nurae/auth/mailer.ts` (Node-only bundle, runs before any SMTP call); `instrumentation.ts` now contains no Node-only imports | FIXED — V00.01.012 |
| BR-006 | Dev log warns `The "middleware" file convention is deprecated. Please use "proxy" instead.` (Next.js 16.3) | Next.js 16.3 renamed the middleware convention; the project still had `src/middleware.ts` exporting `middleware()` | Renamed to `src/proxy.ts` with exported `proxy()` — identical runtime behaviour, verified in dev (warning gone, requests flow) and in the production standalone build | FIXED — V00.01.012 |

## Notes

- Every fix above ships with regression coverage in `tests/nurae/` — the
  suite count is 158/158 as of V00.01.012-beta-03.
- BR-004 evidence: with the owner-provided Gmail app password, a real
  verification-template email was delivered from the sandbox (`250 2.0.0 OK`).
  If mail still doesn't arrive on the device after updating: check spam, use
  the **newest** code (old ones are invalidated), and confirm the two
  `NURAE_GMAIL_*` variables in `.env` — see SETUP.md §10 Troubleshooting.
- Credentials shared in chat should be rotated once testing is done
  (Google Account → Security → App passwords), and the OpenRouter key that
  was exposed earlier should be rotated as well.
