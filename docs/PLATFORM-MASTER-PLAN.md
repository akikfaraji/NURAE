# NURAE — Industry-Grade Platform Master Plan

**Version:** 1.0 · **Date:** 2026-10-20 · **Baseline:** V00.12.000-beta-01
**Scope:** Product, Engineering, Trust & Safety, Legal, Ops, Data, Go-to-Market.
**North star:** anyone — from a non-technical shop owner to a bot veteran — describes an outcome in one paragraph and gets a working, hosted, billable Telegram bot in minutes; NURAE runs it 24/7, meters it, grows it, and keeps it safe. That is the gap between NURAE and coding agents (Claude Code, opencode, cursor): they hand you code; NURAE hands you a running business object.

---

## 0. Executive summary

| Track | Today | Target (this plan) |
|---|---|---|
| Builder agent | Builds from prompt; one clarifying question max; thin bots on vague input | `agent_ask_user` tool with interactive question cards, slot memory, blueprint proposals, completeness gate |
| Tool-call UI | Linear audit feed, one approval bar | Refined activity system: grouped steps, typed icons, live states, interactive question cards, summary chips |
| Catalog/content | Agent-generated shell; user must know what to fill | Guided "fill your catalog" flow in chat + dashboard editor |
| Configuration | Raw provider/model/temperature fields | "Brains" preset wizard; advanced panel for pros; one-click AI test |
| Anti-abuse | Email code + Google OAuth + rate limits; free trial/daily units abusable by multi-accounting | Tiered verification ladder, fraud scoring, referral integrity, publish/broadcast gating, admin abuse console |
| Legal | Passwords/hashing done; no public policy suite | ToS, Privacy, AUP, AI disclaimer, refunds, DMCA, retention — counsel-reviewed |
| Ops | Single-process + SQLite; dev.log; split-E2E CI | Backups with tested restore, monitoring/alerting, status page, scale-out path |
| Growth | Built-in referral loops, 5 templates | Template gallery (UGC), migration-from-coding-agents page, education engine |

Phasing: **Phase 0** (weeks 1–2) ships the four UX features + anti-abuse v1 + legal boilerplate. **Phase 1** (weeks 3–6) hardens trust, onboarding, ops. **Phase 2** (months 2–4) scales: marketplace, teams, Postgres path, compliance audit.

---

## 1. Where we are — honest audit

**Assets (keep, they are the moat):**
- Behavior engine with a genuinely wide surface: triggers (`start`, `command`, `keyword`, `text`, `button`, `payload`, `member_joined`, `fallback`), steps (`message`, `collect`, `media`, `poll`, `payment` (Stars), `schedule`, `remember`/`draw`/`top`), buttons (`url`, `callback`, `webapp`, `copy`), reply keyboards, `{{placeholder}}` templating with fallbacks (`capabilities.ts`). Most "build me a Telegram bot" SaaS stops at keyword-reply; this is beyond that.
- Agent layer with the right security spine: tools-only world access, ownership filtered at query level, zod-validated args, approval-required consequential actions, full audit (`tools.ts`, `bot-builder.ts`).
- Money plumbing: pay-as-you-use wallet (micro-dollar ledger), Stars + crypto topups, per-feature pricing (`billing/`).
- Growth loops already compiled into every template: deep-link referral attribution, invite counters, leaderboards (`templates.ts`, `referral.ts`).
- Operations discipline: structured logs (`dev.log` rotation), ai-health probes, key-health banners, schema-sync, split-E2E CI, large vitest suite.

**Gaps (this plan closes):**
1. Vague prompt → thin bot. The builder asks ≤1 question and guesses.
2. The agent has no *structured way to wait for the user*; it can only emit prose questions.
3. Tool-call feed is an audit trail, not a product surface.
4. No guided content filling (catalog items, FAQs, media) — non-technical users stall at "now add your products".
5. Config exposes provider/model/temperature/maxTokens — engineer vocabulary.
6. Verification exists, but identity *uniqueness* doesn't: one human can farm trial + daily free units across accounts, and self-invite through the referral loop.
7. No public legal stack (ToS/Privacy/AUP), no DMCA path, no AI-output liability language.
8. Single SQLite node; backups/restore unproven; no uptime alerting or status page.
9. No funnel instrumentation → we can't see where users stall.

---

## 2. Product strategy — two audiences, one ladder

**Principle: progressive disclosure.** The same product, three altitudes; users climb only as far as they want.

| Altitude | Who | Surface |
|---|---|---|
| **Outcome** | Non-technical (default) | Chat with the builder agent. Questions as tap-friendly cards. Templates gallery. "Publish" button. Never see provider/model/behavior JSON. |
| **Curator** | Grew confident | Dashboard bot detail: behaviors rendered as editable cards (flows, buttons, messages), catalog/content editor, audience table, broadcasts. Still no jargon. |
| **Professional** | Ex-BotFather/coding-agent users | Advanced panel: raw provider/model/base URL/temperature, behavior JSON editor, commands/replies escape hatches, REST + MCP endpoints (already exist), webhooks, BYO provider keys. |

**Why pros choose NURAE over coding agents:** agents write code that *they* must host, meter, secure, and babysit. NURAE gives: hosted 24/7 runtime, payment rails (Stars/crypto) already wired, audience + billing dashboards, broadcast/schedule infrastructure, referral mechanics, health monitoring, and an audit trail. The migration pitch is one sentence: *"Stop maintaining bot code — describe the bot, we run the business."* For them we keep the professional altitude fully powered (raw JSON editor, API, BYO keys) — power when asked, never by default.

**Why novices stay:** the agent asks like a good consultant (typed question cards with defaults), fills every gap with rich defaults, and the completeness gate guarantees no bot ships half-dressed.

**Rule that protects both:** every advanced control is reachable in ≤2 clicks, and every default is chosen as if the user were non-technical.

---

## 3. Feature specifications

### 3.1 `agent_ask_user` — the agent can ask, the turn waits

**Goal:** the builder asks structured questions mid-build and *stops until the user answers* — mirroring the approval-wait pattern that already works for `bot_publish`.

**Tool spec (add to `tools.ts` registry):**

```jsonc
{
  "name": "agent_ask_user",
  "kind": "read",                    // no state mutation; no approval needed
  "consequential": false,
  "schema": {
    "questions": [                   // 1..4 per batch
      {
        "id": "delivery_method",     // slug, persisted in session slots
        "question": "How should orders reach you?",
        "options": [                 // 0..6; omit → pure free-text
          { "label": "Chat message", "description": "You get each order here in chat" },
          { "label": "Collect & confirm", "description": "Bot saves orders; you confirm in Audience" }
        ],
        "suggest": "Chat message",   // the recommended default, shown as a chip
        "multiSelect": false
      }
    ],
    "title": "Before I build your order flow"   // optional card heading
  }
}
```

**Loop semantics (`bot-builder.ts`):**
- `ToolOutcome.status` union gains `'ask'`.
- `runActions()`: when `action.tool === 'agent_ask_user'` and the record status is `'ask'`, set `state.pendingQuestion = { questions, seq }` and raise a `waitingForUser` flag that breaks the model loop **after** the current batch executes (other actions in the same batch still run — e.g. a draft created before asking).
- The turn ends with the question card rendered; no further model rounds are billed. **Asking is free; the resume turn bills normally.**
- Guardrails: max 4 questions per batch; max 3 ask-batches per build (counter in `AgentState.askCount`) — the prompt tells the model that beyond that it must decide with defaults; `MAX_ROUNDS` unchanged.

**Resume path:**
- The message API already accepts a text turn. When `session.state.pendingQuestion` exists, the API wraps the incoming text as a structured answers block:

```
USER ANSWERS:
1) delivery_method → Chat message
2) catalog_items → "12 dishes, photos later"
```

- It clears `pendingQuestion`, persists the answers as the user entry (so history and reloads are truthful), and runs the turn. Free-text replies to a card are first-class: the model gets both the raw text and the slot ids.

**State & reload:** `AgentState` gains `pendingQuestion` and `slots: Record<string,string>`. The last assistant entry's `meta` gains `pendingQuestion` (like `needsConfirm` today), so a reload re-renders the live card. Answered slots accumulate in `slots` and are injected into the system prompt ("KNOWN REQUIREMENTS: …"), so the agent never re-asks.

**UI (agents-view + new `QuestionCard`):**
- Card renders in the message flow (not the composer) with: title, one row per question, option **chips** (tap to select; multi-select toggles), the suggested default visually marked ("Suggested"), a free-text field per question, and one **Submit answers** button. Selected state animates; submit posts one message and the card collapses to a compact "Answered · 3/3" receipt.
- Composer is disabled with a subtle "Waiting for your answers" shimmer while a question is open (same pattern as the approval bar, but richer).

**Prompt addition (one paragraph in `builderSystemPrompt`):** when intent is recognized but ≥2 high-impact slots are unknown → call `agent_ask_user` once with the top 3 questions, each with a suggested default. After answers, present the one-paragraph blueprint (what will be built, what was assumed) and build. Slot checklists per blueprint (shop / booking / FAQ / quiz / giveaway / community) ship as a builder skill via `skill_read` (already the mechanism).

**Tests:** registry validation (rejects >4 questions, >6 options, duplicate ids); loop breaks on ask and resumes on answers; free-text resume; reload restores card; `askCount` cap forces defaults; billing — ask turn not charged, resume charged.

**Effort:** ~3 dev-days (tool + loop + state + card UI + tests).

### 3.2 Tool-call UI refinement system

Today's feed is honest but flat (✓ rows + one approval bar). Upgrade to a legible activity system in `agent-activity.tsx`:

1. **Typed steps:** each tool gets an icon + past-tense verb ("Created draft bot", "Wired 5 behaviors", "Charged $0.003"). Mapping table in one module, so new tools inherit a default.
2. **Statuses:** running (spinner), ok (green check), error (red with the human detail inline), confirm (amber "Waiting for your approval"), **ask** (blue "Waiting for your answers").
3. **Grouping:** consecutive tool steps of one round collapse into a single expandable group ("Set up the shop · 6 steps") with the group headline from the agent's narration line; tap to expand every step and its `dataPreview`.
4. **Live feel:** keep the 260 ms stagger; add a "thinking" pulse on the agent avatar during rounds; steps stream in as they execute.
5. **End-of-turn summary chip:** one line — "Built 4 behaviors · 2 flows · catalog shell · 1 knowledge doc · draft ready to publish" — generated from the AgentStep summary, clickable to open the bot.
6. **Error affordance:** a failed step shows "Retry this step" when idempotent (re-issues the same tool call) — recovery without re-explaining.

**Effort:** ~2 dev-days. No API changes (all data already in `AgentStep`/meta).

### 3.3 Catalog & content filling — "the shell fills itself"

The catalog shell only works if filling it is easier than Excel.

1. **Chat path (Phase 0):** after building a shop shell, the agent *asks* (`agent_ask_user`) for products in bulk: "Paste your menu — one item per line, `name | price`". Parser turns lines into catalog slots; photos optional ("send images and I'll attach them to items").
2. **Dashboard path (Phase 0.5):** a **Content tab** on bot detail for bots detected as catalog-shaped: a simple item editor (name, price in Stars, photo URL, description) that writes into the bot's behaviors/knowledge — no JSON visible; "Preview in Telegram" button sends the menu to the owner's chat.
3. **Import (Phase 1):** paste-a-URL (Google Sheets published CSV) or upload CSV/XLSX; map columns once; re-import updates.
4. **Contract:** catalog lives in structured storage (bot attributes/knowledge), rendered through `{{placeholders}}` in behaviors — the behavior engine stays the single execution truth; the Content tab is a *view over it*, never a second runtime.

**Effort:** chat path ~2 days; content tab ~3 days; import ~2 days.

### 3.4 Configuration — "Brains" wizard instead of raw fields

Replace the current provider/model/temperature wall in bot config with:

1. **Step "Brains":** three preset cards built from `PROVIDER_CATALOG` availability (env keys + stored keys known server-side):
   - **Smart** — best quality (maps to the strongest configured provider/model)
   - **Fast** — cheap & quick (maps to a fast configured provider/model)
   - **Free** — no cost (free-tier gateway models, e.g. the orca/openrouter free catalogs)
   Each card shows plain-language consequences ("Smart = better answers, costs a bit more per message"). Selecting sets provider+model under the hood.
2. **One-click "Test"**: runs the existing chat-first `validateCredentials` probe and renders the human verdict from `key-health` ("Works — the AI answered in 0.8 s" / "Key rejected — check the key").
3. **Advanced (collapsed by default):** the current fields verbatim — provider, model, base URL, temperature, max tokens, memory size, custom keys — exactly for the professional altitude. Nothing is removed; it's demoted.
4. **Copy rules:** every label passes the "shop-owner test" (no API words); every error carries the fix ("The bot's AI key was rejected (401). Paste a new key or switch to Free brains.").

**Effort:** ~3 dev-days.

### 3.5 First-run & onboarding

1. **Signup → 60-second first bot:** after verification, one screen: "What do you want your bot to do?" with 5 template cards + "Describe in your own words" — both routes land in the builder agent with the appropriate slots pre-known.
2. **Bot health checklist** (bot detail): token ✓ · brains ✓ · /start tested · profile set · published — each row actionable.
3. **"Test in Telegram"** deep link (t.me link to the draft with a sandbox note) once token exists.
4. **Empty states everywhere** teach the next action instead of showing zero tables.

**Effort:** ~3 dev-days across surfaces.

---

## 4. Trust, Safety & Anti-Abuse (the "many other gaps" plan)

### 4.1 Identity verification ladder

| Level | Mechanism | Unlocks | Cost |
|---|---|---|---|
| L0 | Email 6-digit code (exists) | Account, free daily units, draft bots | ~0 |
| L1 | Google OAuth (exists) | Same as L0 | ~0 |
| L2 | **Phone OTP** (new; provider e.g. Twilio/MessageBird; hash stored, never plaintext) | Publish bots, broadcasts | ~$0.01–0.05/verify — only charge the check when risk-scored or after N free bot publishes |
| L3 | Payment instrument (first Stars/crypto topup of any amount) | High quotas, referral payouts, broadcast beyond 500 users | 0 (it's revenue) |

Rules: publish requires L0+ (verified email) from day one; broadcasts and referral payouts require L2; the ladder is shown *as benefits*, never as suspicion ("Verify to publish — it keeps bots honest").

### 4.2 Multi-accounting & fraud signals (v1, no creepy tech)

1. **Disposable-email blocklist** at registration (open source list + manual additions; admin-toggleable).
2. **IP/ASN velocity:** >N verified signups / 24 h from one IP or ASN → step-up to L2 for that cohort (soft, not hard-block — NAT offices exist).
3. **Trial economics:** the 7-day trial and daily free units bind to **verified identity** (L0). Unverified accounts browse and build drafts but cannot publish or broadcast.
4. **Referral integrity:** credit only when the invitee reaches L1+ and performs a real action (bot published or first AI turn); same-IP-cluster inviter/invitee pairs → flagged, not auto-credited; invite counters already cap volume (`NURAE_INVITE_DAILY_CAP`); add per-inviter anomaly review in admin.
5. **Broadcast anti-spam:** recipients=everyone requires L2 + first broadcast limited to 100 with a content check (existing behavior validation + a simple spam-heuristic pass); unsubscribe already exists (email) — add in-chat "STOP" for platform bots.
6. **Payment abuse:** Stars topups are Telegram-mediated (low fraud); crypto manual addresses require 1 confirmation and bind to the paying account; flag topup→immediate-withdrawal-style patterns (none exists yet — note for when payouts land).

### 4.3 Abuse console (admin)

Extend the admin customers page: risk score per account (signals above), linked-account candidates (shared IP/ASN at signup, shared referral graph), one-click actions: require step-up, pause broadcasting, suspend, purge referral credits (all logged to the audit trail).

### 4.4 Content safety (minimum viable, honest)

Bots are user content. V1: AUP in ToS; report button on public bot pages; hash-based blocklist for known-bad payloads in knowledge/docs; AI-system-prompt injection can't escalate (tools-layer identity already guarantees this); moderation queue only for reported bots. Document that self-hosters own their content.

**Effort Phase 0 anti-abuse:** ~4 dev-days (blocklist, velocity, publish-gating, referral credit rules). Phase 1: ~5 days (phone OTP, abuse console, broadcast guardrails).

---

## 5. Legal & Compliance (checklist; counsel review before publish)

| # | Item | Notes |
|---|---|---|
| 1 | **Terms of Service + Acceptable Use** | User bots = user content; host discretion to suspend; AUP bans spam/scam/illegal; jurisdiction + dispute path |
| 2 | **Privacy Policy + cookie consent** | What's stored (email, hashed phone, encrypted bot tokens/keys, chat logs, logs with IPs), retention, sub-processors (email SMTP, SMS, hosting, AI providers act as processors for bot traffic) |
| 3 | **AI disclaimer** | Output may be wrong; human review for consequential uses; no professional advice |
| 4 | **Refund policy** | Stars: follow Telegram's payment terms (they mediate); crypto topups: clearly "final, no auto-refunds" with a goodwill manual process; wallet balance expiry policy stated |
| 5 | **DMCA / takedown** | Registered agent, notice→counter-notice flow for public bot pages |
| 6 | **Data rights** | Export (JSON of account data) + deletion flow (erasure), both self-serve in dashboard; deletion breaks bot encryption refs — warn explicitly before executing |
| 7 | **Minors** | 13+ (16+ where required); no knowingly collecting minors' data |
| 8 | **Sanctions/export** | ToS geofence clause; payment-processor reality does most of the work; revisit if payouts launch |
| 9 | **Crypto topups** | Keep manual flow (low AML burden); when automatic (CryptoBot) ships, add thresholds + logging; no custody of user funds beyond wallet balance definition in ToS |
| 10 | **Telegram platform compliance** | Bot API ToS, brand guidelines (name/logo usage), anti-spam alignment — one review pass, then a release checklist item |
| 11 | **DPA for self-hosters** | Simple rider: they are the controller; NURAE ships no telemetry by default |
| 12 | **Incident response** | 72-hour breach notification policy; on-call path (even if on-call is one person + agents) |

**Effort:** templates + policy pages ~3 dev-days; **counsel review is a real budget line — do not skip it.**

---

## 6. Engineering & IT operations

1. **Backups/DR (Phase 0):** nightly SQLite backup (`.backup` API) + `NURAE_SECRET_KEY` escrow procedure; restore drill monthly (documented runbook); offsite copy (S3/R2) encrypted. *A backup that has never been restored is a rumor.*
2. **Monitoring (Phase 1):** uptime probe on `/api/health` + `/api/ready` (external), alert on ai-health degradation, disk/memory, webhook error rates; dead-man's-switch for the bot fleet; status page (public).
3. **Error tracking (Phase 1):** self-hosted Sentry or equivalent; PII scrubbing; wire the existing `AGENT_TURN_FAILED`/`BOT_ERROR` taxonomy into it.
4. **Scale path (Phase 2):** SQLite→Turso/Postgres migration plan (Prisma makes this mostly mechanical); the gateway-link split (frontend ⇄ backend) already exists — document the horizontal story: N backends, one DB, Caddy routing webhooks.
5. **Security backlog:** rate limits exist for auth — extend per-feature budgets; CSP review; dependency audit in CI; secrets scanning pre-commit; the SSRF guard + redirect-rebinding work in the AI layer is already strong — keep it the standard for any new outbound fetch.
6. **Quality gates:** no PR without: targeted vitest green, `tsc --noEmit` clean (excluding generated `.next`), lint; release checklist includes legal items (§5 #10) and backup-drill date.
7. **Accessibility & i18n (Phase 1–2):** WCAG AA pass on dashboard (contrast, focus, labels — the audit found placeholder-heavy inputs); i18n foundation when non-English traffic justifies it; the agent already replies in the user's language — extend template copy later.

---

## 7. Data & KPIs (instrument from Phase 0)

Privacy-respecting, first-party events only (no third-party pixels needed to start):

| Funnel | Event | KPI target (90 days) |
|---|---|---|
| Acquisition | signup_started / verified / first_bot_created | verified ≥ 60 % of signups |
| Activation | first_bot_published / first_agent_build_completed | ≥ 40 % of verified users publish a bot |
| Depth | avg behaviors per published bot; ask-tool usage | ≥ 4 behaviors; ≥ 50 % of builds use ≥1 ask batch |
| Retention | D7 owner return; bots alive at D30 | D30 bot survival ≥ 70 % |
| Money | free→paid conversion; ARPU; topup repeat rate | ≥ 5 % of active builders pay |
| Growth | referral K-factor; template installs | K ≥ 0.3 |
| Reliability | agent turn error rate; webhook success rate | < 1 % turn errors; > 99.5 % webhook ok |

Anti-abuse dashboards read the same events (velocity views) — one pipeline, two lenses.

---

## 8. Go-to-market — why users leave coding agents for NURAE

1. **Positioning line (site + docs):** "Describe your bot. NURAE builds, hosts, and runs it — payments, audience, broadcasts included. No code, no server, no maintenance."
2. **Migration page:** "Coming from BotFather / a coding agent?" — paste a token, describe the old bot, the builder reconstructs it as behaviors; a checklist maps what they had (commands, replies, payments) in one pass. Pros get the JSON editor + REST/MCP on the same screen.
3. **Template gallery (Phase 1, UGC):** publish any bot as a reusable template (owner credited + referral hooks intact); featured curation; installs are one click. This is the marketplace seed — and a moat coding agents can't copy, because templates here *run*, not scaffold.
4. **Education engine:** 60-second gifs per blueprint; a "build your first shop bot" interactive walkthrough (the agent itself teaches via ask-cards); docs site with per-blueprint pages (the builder skill index already contains the bones — publish them).
5. **Distribution that Telegram gives us for free:** every bot carries the NURAE referral loop today; add an in-Telegram "/about" for all fleet bots pointing to the site; community + channel links exist in env — activate with content cadence.
6. **Pricing honesty:** free tier generous enough to finish a real bot (daily units + trial), paid only when a bot *works* (usage) or needs scale (broadcast volume) — the moment of payment coincides with received value, not with onboarding. Revisit per-feature prices from wallet telemetry after 90 days.

---

## 9. Support & documentation

- In-app help page exists → add per-blueprint guides + "the agent can do X" catalog page (same content the builder prompt uses — one source, rendered).
- Support channels: Telegram community (primary), email for billing/abuse; SLA wording for future Pro tier (48 h → 24 h).
- Every destructive/error path in the UI must link to the doc section that fixes it (error message → doc anchor convention).

---

## 10. Roadmap

### Phase 0 — "Make the magic legible" (weeks 1–2)
| # | Item | Effort | Acceptance |
|---|---|---|---|
| 1 | `agent_ask_user` tool + QuestionCard UI + slot memory | 3 d | Vague "make me a shop bot" yields ≥1 ask-card, answers persist, reload restores card, tests green |
| 2 | Tool-call UI refinement (typed steps, grouping, summary chip) | 2 d | Feed reads as narrative; no API change |
| 3 | Brains wizard + Test button in bot config | 3 d | New bot configurable without seeing "temperature"; probe verdict human-readable |
| 4 | Catalog chat-fill flow (bulk paste) | 2 d | 10-line paste → 10 items rendered in menu flow |
| 5 | Anti-abuse v1 (disposable blocklist, IP velocity, publish-gate on verified email, referral credit rules) | 4 d | Multi-account trial farming blocked at publish; referral self-invites not credited |
| 6 | Legal boilerplate pages + consent | 3 d | ToS/Privacy/AUP/refunds live; signup checkbox; counsel review scheduled |
| 7 | Backup nightly + first restore drill | 2 d | Restore drill documented and passes |

### Phase 1 — "Trust + depth" (weeks 3–6)
Phone OTP step-up (L2) · abuse console · broadcast guardrails · dashboard Content tab + CSV import · onboarding 60-second flow + health checklist · template gallery v1 (the 5 built-ins + submit flow) · monitoring + status page + error tracking · a11y pass · funnel events.

### Phase 2 — "Scale + marketplace" (months 2–4)
Postgres/Turso path rehearsed · template marketplace with rev-share terms · team accounts/roles · Pro tier with SLA · public REST/MCP widening · i18n · compliance audit (counsel) · mobile polish/PWA.

---

## 11. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Ask-cards become an interrogation → users churn | Hard caps (≤3 batches/build), defaults always offered, blueprint-confirm absorbs the rest |
| SMS costs abused by OTP farming | Verify only on risk signals or after free-publish threshold; per-IP/day OTP budget; hash+rate-limit phone numbers |
| Free-tier abuse survives v1 signals | Publish/broadcast gating is the real wall; economics: free units bind to verified identity; escalate by behavior, not by blocking |
| Legal gaps found late | Counsel review is a Phase 0 gate for public marketing; nothing public claims compliance until reviewed |
| SQLite ceiling hit by growth | Gateway-link split already exists; rehearse Turso/Postgres migration in Phase 2 *before* it's urgent |
| Agent quality varies by provider/model | Keep the envelope+markup dual parser; completeness gate is prompt+tool enforced, not model-hoped; budget floor (`AI_ROUND_TOKEN_FLOOR`) already guards truncation |
| Feature creep delays Phase 0 | Everything above Phase 0 is explicitly deferred; the roadmap is the scope contract |

---

## 12. Open decisions (owner's call)

1. SMS provider + budget for L2 verification (Twilio vs MessageBird vs WhatsApp-OTP alternatives).
2. Whether publish-gating (verified email required) applies to *existing* accounts at deploy or only new ones (recommend: new, with a gentle banner for existing).
3. Marketplace rev-share % and whether template installs are free-but-attributed.
4. Jurisdiction/entity for ToS (recommend deciding before Phase 0 legal pages ship).
5. i18n priority languages (based on early signup geography once analytics land).
