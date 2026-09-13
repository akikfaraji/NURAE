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
| BR-007 | Gmail tags NURAE verification mail as spam — codes "never arrive" | Sender reputation of a fresh Gmail account + template-less OTP mail is a classic spam-filter trigger; delivery itself works (BR-004 fix) | Spam-folder guidance added where it matters: the verify step now always shows "Check the SPAM / Promotions folder — use the NEWEST email", the /help FAQ has a full answer, README/SETUP mention it; the official CS bot prompt already covers it | MITIGATED — V00.01.013 (filter behaviour is on Gmail's side) |
| BR-008 | The customer site header shows a clickable **ADMIN** link — users must not see operator access | The shared `SiteHeader` rendered an `/admin` link unconditionally | Admin link removed from the public site entirely; the owner reaches `/admin` by URL (documented in README §1) | FIXED — V00.01.013 |
| BR-009 | Page has "2 heads" — two stacked header bars (site header + chat card header with its own Sign out) | The chat card duplicated brand tile, account email and Sign out below the site header | Single-head layout: account controls (email + Sign out) moved into the site header; the chat card is now one slim toolbar (bot name + online dot) | FIXED — V00.01.013 |
| BR-010 | Web chat shows raw markdown (`**bold**`, `###`, `[links](…)`) in AI answers | Bubbles rendered plain text; `react-markdown` was never wired into the chat | Assistant bubbles render through react-markdown + remark-gfm with new monochrome `.md-body` styles (headings, bold, code, links, lists, tables, quotes); verified in-browser — zero raw markers visible | FIXED — V00.01.013 |
| BR-011 | "Where are the other pages for users? Chat is only one of the many pages" | The public site was a single page (landing + auth + chat jammed together) | Real multi-page user site: `/` (home + auth), `/chat` (dedicated full-height chat, sign-in-guarded), `/help` (FAQ + contact from site settings), `/about` (about + contact); shared nav header + footer; sign-in redirects into `/chat` | FIXED — V00.01.013 |
| BR-012 | The /about page shows a duplicate footer (page-level version strip + site footer) | The About page rendered its own bordered version/vendor strip in addition to `SiteFooter` | In-page strip removed — the footer alone carries version + vendor; verified one `contentinfo` per page | FIXED — V00.02.000 |
| BR-013 | The product "looks like an AI-generated SaaS template": everything boxed in cards, giant header, prominent Sign out, one boxed chat page | Structural, not cosmetic: the UI had no product model behind it | Full product round (see worklog Task 18): compact 48px chrome with the account menu (Sign out behind it) and small N mark top-right; `/chats` rebuilt as a full-page conversation environment (typography, not bubbles); new `/chats/agents` (real Bot Builder agent over an audited tool layer), `/bots` (user-owned bots, commands/buttons/workflows, real-pipeline test console), `/featured`; file uploads with PDF/DOCX extraction; chat → agent handoff; server-side referral + entitlements; design language is typography and spacing — no gradient/card clutter | FIXED — V00.02.000 |

## Notes

- Every fix above ships with regression coverage in `tests/nurae/` — the
  suite count is 188/188 as of V00.02.000-beta-03 (page-level UI changes are
  additionally verified in a real browser; React components have no vitest
  harness yet).
- BR-004 evidence: with the owner-provided Gmail app password, a real
  verification-template email was delivered from the sandbox (`250 2.0.0 OK`).
  If mail still doesn't arrive on the device after updating: check spam, use
  the **newest** code (old ones are invalidated), and confirm the two
  `NURAE_GMAIL_*` variables in `.env` — see SETUP.md §10 Troubleshooting.
- Credentials shared in chat should be rotated once testing is done
  (Google Account → Security → App passwords), and the OpenRouter key that
  was exposed earlier should be rotated as well.
