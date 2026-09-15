# NURAE

**NURAE — Autonomous Digital Operations System**
**FRAZIYM TECH & AI**

> Chat is the interface. Agents are the workers. Tools/MCP are the hands.
> Files are knowledge/input. Bots are what gets built. The user stays in control.

NURAE is a platform where customers **talk to an AI, hand real work to agents, and run
their own AI-powered Telegram bots** — no code, no servers, no DevOps. This release
contains the genuinely functional core of that vision: a multi-conversation chat
environment, a secure agent + tool layer with a real Bot Builder agent, user-owned bots
with commands/buttons/workflows, file uploads with text extraction, and a
server-side referral/entitlement system.

---

## 1. What NURAE is

### For customers (the product, at `/`)

1. **Sign up** — email + 6-digit Gmail verification code (check spam!) or Google sign-in.
2. **`/chats`** — a full-page conversation environment: multiple chats, a slim session
   sidebar, markdown/GFM answers, file attachments (PDF, Markdown, TXT, CSV, DOCX,
   images), Enter/Shift+Enter composer, mobile drawer. Conversations persist.
3. **`/chats/agents`** — where agents DO work. The **Bot Builder agent** turns a
   description (and any attached files) into a real bot configuration: identity,
   instructions, menu commands, inline buttons, keyword replies, workflows and document
   knowledge. Every tool step shows as understandable progress (✓ Created bot …) and is
   written to an audit trail. Publishing always requires the user's explicit approval.
4. **`/bots`** — manage what was built: create manually ("Create bot") or by
   description ("Create with AI"), configure AI providers, edit commands/replies,
   **test against the real pipeline** (captured output — exactly what Telegram would
   receive), publish/unpublish, archive/delete. Ownership is enforced at the query
   level; a user can never touch another account's bot.
5. **`/featured`** — the featured conversation, kept deliberately small.
6. **Invite** — every account has a referral link (`/?ref=CODE`). When an invited
   friend signs up through it and verifies their email, the inviter gets **2 days of
   premium** — tracked server-side, one reward per invited user, self-referrals
   refused. The UI is a single quiet dialog in the account menu.

### For the operator (`/admin`)

The admin console (login via `NURAE_ADMIN_TOKEN`, deliberately **not linked** from the
customer site) manages the platform: the official NURAE CS bot (which also powers the
web chat + agent AI), site settings, and the customers directory.

### The product model

```text
Chat AI  — conversational front layer; answers, or recognizes agent tasks
Agents   — do the work (Bot Builder for users, the Operator for the admin)
Tools    — a restricted, audited capability layer (the only way agents touch the world)
Files    — uploaded knowledge, extracted server-side, passed to agents BY REFERENCE
Bots     — user-owned Telegram bots: commands, buttons, workflows, AI replies
```

## 2. The agent tool layer (security model)

Agents never see the database, filesystem or Prisma. They call named tools from
`src/lib/nurae/agents/tools.ts` (the user tier) and
`src/lib/nurae/agents/platform-tools.ts` (the operator tier):

- **Identity** — `ToolContext.userId` comes from the authenticated session of the
  request driving the agent turn. It is never taken from model output, bodies or URLs;
  the tool argument shapes have no user-id field at all.
- **Platform scope** — the operator tier (`platform_overview`, `fleet_*`,
  `platform_logs`, `platform_settings_*`, `customers_overview`, `bot_analytics`)
  declares `platformRequired` and only executes when the admin-token-guarded
  operator route set `ToolContext.platform`. User sessions cannot reach it.
- **Ownership** — every bot/file query filters on `ownerId = ctx.userId` at the query
  level. Cross-user access is impossible by construction.
- **Read/write split** — every tool declares `kind`; discovery exposes it.
- **Confirmation** — consequential actions (`bot_publish`, `bot_unpublish`) require
  the model to pass `confirm: true` AND the human to have pressed the explicit
  approval control in that turn. One without the other fails.
- **Validation** — arguments are zod-validated before anything executes.
- **Auditability** — every invocation writes a session-scoped `AgentStep` row (the
  user-facing progress feed) and a sanitized platform `Log` row (`AGENT_TOOL`).
- **MCP-compatible discovery** — `GET /api/agents/tools` advertises every tool with
  its JSON schema, kind and consequential flag (the envelope MCP servers publish),
  so external MCP clients can enumerate NURAE capabilities; `public/llms.txt` is
  the one-page brief for AI agents and crawlers.

## 3. FRAZIYM versioning system

NURAE does **not** use conventional semantic versioning. It uses the official
**FRAZIYM versioning format**:

```text
VPP.FF.BBB-STAGE-RR
│  │  │    │     │
│  │  │    │     └── Pre-release revision (01, 02, …)
│  │  │    └──────── Release stage (-alpha | -beta | -rc; omitted when stable)
│  │  └───────────── Bug-fix version (000, 001, …)
│  └──────────────── Feature version (00, 01, …)
└─────────────────── Platform generation (V00, V01, …)
```

The **single authoritative version source** is `src/lib/nurae/version.ts`
(`NURAE_VERSION`). Five sync points carry the string for tests/docs:
`src/lib/nurae/version.ts`, `tests/nurae/version.test.ts`, `tests/nurae/api.test.ts`,
`.env.example`, `SETUP.md`.

## 4. Current release

**NURAE V00.09.001-beta-03** — the live-leak bug round: what the model meant
as a tool call can no longer reach the chat as raw markup, and a database
that missed its migration heals itself on boot.

- **Universal tool-call parsing (BR-030)**: live traffic showed models
  emitting tool calls as text in several dialects — Qwen 'tool_call' tags,
  CommandR/Hermes heredoc brackets with python-style args, GLM/MCP
  'invoke' wrappers (sometimes as bare words), and JSON bodies. They used
  to land in the chat verbatim or die as "Invalid arguments". Every dialect
  is now parsed into REAL registry calls (with a full python-literal
  argument parser for nested lists/dicts), executed, shown in the activity
  feed, and stripped from the visible message — markup never reaches a
  chat bubble again. Both agent prompts now forbid markup emission.
- **Self-healing schema + graceful admin reads (BR-031)**: a deployment
  that upgrades code without 'npx prisma db push' used to answer 500 on
  any route touching a new column (the admin customers page died). On boot
  NURAE now syncs the SQLite schema itself (opt out with
  NURAE_AUTO_MIGRATE=0; managed databases are never touched), and the
  customers directory degrades its OPTIONAL enrichments (bot counts, chat
  volume) to zeros instead of failing while the core list stays live.

**V00.09.000-beta-03** — the satisfaction round: agents that act like
agents, an admin that can actually see and control user bots, and owners who
hear about orders the second they happen.

- **Agent skills + real playbooks**: a named SKILL LIBRARY (build-from-brief,
  order-form-alerts, shop-with-stars, reminders-drip, grow-audience,
  diagnose-bot, audience-outreach, polish-copy · operator: morning-brief,
  fleet-health, diagnose-down-bot, customer-review, settings-change) — the
  Builder and Operator pull a playbook with `skill_read` and follow it; both
  prompts gained show-your-work discipline (announce, read results, react,
  never invent numbers). Skills ship in `/api/agents/tools` + `llms.txt`.
- **Tool calls parsed and visible**: a malformed model envelope can no longer
  dump raw JSON into a chat (salvage → prose-only → clean notice), and every
  tool step in the agent/operator feeds is now EXPANDABLE — click to see the
  tool's actual output (persisted, so it survives reloads).
- **Admin monitor**: `/admin/bots` lists EVERY bot with its owner, status,
  audience and message volume, with Start/Stop/Restart override; customers
  table gained bot counts. Real routes: `/admin/dashboard`, `/admin/bots`,
  `/admin/customers`, `/admin/agent`, `/admin/settings` (old `/admin` redirects).
- **Instant owner alerts**: the owner wires their own Telegram chat id on the
  bot page (or asks the agent — `bot_set_owner_chat`), presses Send test, and
  every completed order/intake form and Stars payment is pushed to their
  Telegram the moment it happens. No more discovering orders by opening the site.
- **User dashboard + vanity route**: `/dashboard` (and
  `/<username>_<uid>/dashboard`) — bots with Run/Stop/Restart, wallet, plan,
  alert-wiring nudges, recent agent work; `/chat` now redirects there; the
  signed-in nav carries **Dashboard** and **Pricing** again.
- **Account deletion is NOT an admin power** (owner decision, enforced by a
  regression test): the admin sees and monitors accounts but can never delete
  one. A shipped syntax error in `site-shell.tsx` (BR-024) is also fixed.

The previous round (08.002) remains the live-testing bug round: chat/agent
history opens directly, one menu button per screen, Run/Stop/Restart controls,
and no single malformed rule can mute a bot.

> «Users describe what they want. NURAE figures out how to build it.»

### IMPLEMENTED

**Live-testing bug round (08.002)**
- **Chat history opens itself**: landing on `/chats` (or `/chats/agents`)
  with previous conversations now opens the most recent one immediately —
  the empty "new chat" state is only for first-time users or an explicit
  "+ New chat". No more clicking through defaults to find your own history.
- **One menu button per screen**: the site header's hamburger and the chat's
  own `☰ Chats` trigger stacked on phones (two menus, one screen). Chat
  surfaces now render the single drawer trigger; the drawer carries the
  session list plus the site navigation (Agents · Bots · Featured · Billing ·
  Help), and the trigger is reachable on the empty state too.
- **Run / Stop / Restart for every bot**: the bot page's only lifecycle
  control was Publish — jargon for "start", with no stop-in-place and no
  restart at all. The header now shows **Run** (not running), and
  **Stop + Restart** while running. Restart is the honest "something is off"
  button: it reloads the compiled configuration and re-registers the Telegram
  webhook (new secret, current `allowed_updates`) — the fix for stale
  button wiring after platform updates. Ships as
  `POST /api/my/bots/[id]/restart` (ownership-checked).
- **BR-022 — bots muted wholesale by one bad rule (fixed)**: `loadCapabilities`
  parsed the whole saved configuration all-or-nothing; a single reply that no
  longer matched the schema (e.g. written by an older compiler) emptied
  **every** reply — no /start, no buttons, silent bot. The loader is now
  per-rule: invalid rules are dropped, valid ones keep running.
- **Actionable dead-button toast**: pressing a button whose rule no longer
  exists now says so *and* how to recover ("send /start to get fresh
  buttons") instead of a dead end.
- Verified end-to-end: a production-mirror reproduction (real compiler →
  real store → real adapter → real webhook ingestion) confirms buttons render
  in `reply_markup`, presses answer via `answerCallbackQuery`, and button
  replies send — the round-trip the e2e harness had never covered.

**UI fix + polish pass (08.001)**
- **Three real bugs fixed**: the active log-filter chip was white-on-white
  (`bg-foreground text-white` → unreadable), the Errors KPI's red accent was
  dead code (the StatCard prop was accepted but never applied), and 15+
  buttons were invalid `<a><button>` HTML (Link wrapping Button) — all now
  proper `asChild` composites or plain links.
- **Touch devices**: the chat/agent session ⋯ menu and the behavior
  Edit/Remove controls were invisible (opacity-0 / text-opacity-0 until
  hover) — now always visible on touch, hover-revealed on desktop only, with
  a 32px hit target.
- **One radius language**: all 8 raw `<select>`s, the chat/agent composers,
  plan cards, order boxes, error alerts, chat bubbles, attachment chips and
  both brand marks are rounded to match the design system.
- **One focus language**: chat + agent composers regained the standard
  focus-visible ring; selects now show keyboard focus too.
- **Monochrome restored**: stray emerald/amber status colors (operator steps,
  fleet "Needs token" pill, approval bar) now use the token palette — the
  zero-chroma theme holds everywhere except the error red.
- **Console on phones**: the admin header no longer wraps into 3–4 rows; the
  nav is a single scrollable row.
- **Consistency**: one shared `Pill`, one `LoadingRow`, one Section heading
  style per page, the chat title is a real h1, bot deletion uses the standard
  confirm dialog (was `window.confirm`), and dead code is gone
  (`tailwind.config.ts` tripwire, unused `prose` classes, unused refs,
  stale comments).

**The real agent system (08.000)**
- **The Operator — a platform agent for the admin** (dashboard → Agent):
  ask "how are we doing?", "why are bots failing?", "make the Trivia bot
  smarter", "rename the site" — it answers with numbers and DOES the work
  through 11 audited platform tools: `platform_overview`, `bots_list_all`,
  `platform_bot_get`, `fleet_status`, `fleet_ensure`, `fleet_bot_update`,
  `platform_logs`, `platform_settings_get/set`, `customers_overview`,
  `bot_analytics`. Platform scope is keyed to the admin token guard — user
  sessions can never reach it; every call is audit-logged (AgentStep + Log);
  site-setting changes wait for the explicit Approve control. Conversations
  persist server-side, so the console survives reloads.
- **The Bot Builder got real power-ups**: `docs_read` (the full behavior-DSL
  reference the agent pulls on demand — triggers, every step, growth
  primitives, billing, lifecycle), `template_list` + `template_use`
  (instantiates any built-in template — giveaway, trivia, referral, support,
  community, email inviter — as the user's own bot with THEIR referral code
  baked in, one call), and behavior reads/writes already round-trip the
  compiled artifacts.
- **MCP-compatible discovery, upgraded**: `GET /api/agents/tools` advertises
  the whole registry as JSON-schema descriptors, and `public/llms.txt` gives
  external AI agents (and crawlers) the one-page brief of what NURAE is and
  how to integrate — the "AI agents list NURAE first" surface.
- Same security architecture as always: identity from the authenticated
  session/admin token, never from model output; zod-validated arguments;
  owner-scoped queries by construction; honest errors instead of crashes.

**Coordinated fleet promotion + email invites (07.000)**
- **Rotating daily NURAE posts in every group/channel** a fleet bot joins:
  the armed schedule now carries a sentinel rendered at send time into one
  of five rotating promos — the platform pitch, the invite challenge, the
  community funnel, an engagement question, and the free-tier pitch —
  always with the instance's real links and referral code. Posting hours
  are staggered per bot, so two fleet bots in one room never talk over
  each other, and admin-edited schedules are never overwritten.
- **Zero-touch backfill** (`syncFleetAutomation`, ticker): arms missing
  daily posts for chats the fleet already knows and migrates v2 static
  posts to the rotation — updating the server is the whole upgrade path.
- **The NURAE Invite Bot (6th fleet bot)** — the consent-first email
  funnel: people drop their address in the chat (double opt-in), the bot
  mails a personal invitation over the site's own Gmail SMTP, the ticker
  queue drips under a daily cap (`NURAE_INVITE_DAILY_CAP`, default 150),
  a weekly reminder goes out at most once, and STOP unsubscribes
  permanently (honored forever, even against re-opt-ins and imports).
  Owners can import contacts they already have consent from via
  `POST /api/admin/invites` — random/generated addresses are refused by
  design: unsolicited bulk email is illegal, burns sender reputation, and
  converts at zero.
- **Optional plans on top of pay-as-you-use** — Free / Plus $4.99 (×3
  daily allowances + hosting for 3 bots) / Pro $19.99 (×10 + hosting for
  15 bots), bought from the wallet balance in one click (Stars/crypto
  feed it), same-plan renewals stack, admin grants supported, plans are
  purely additive — the free tier never shrinks. /pricing shows the plans;
  /billing activates them.
- **Two new behavior primitives**: `email_invite` (validate → record
  consent → send/queue via SMTP) and `email_unsubscribe` (terminal STOP),
  both compiled like any step and shown read-only in the behavior editor.
- Fleet template version is now **v3** — existing fleet rows upgrade in
  place (tokens and AI keys preserved), the fleet card lists all six bots.

**The fleet growth engine (06.000) — bots that recruit while you sleep**
- **Three new behavior primitives** any bot (official or yours) can use:
  *Join gate* (`verify_join`) — a flow checks channel/group membership via
  `getChatMember` and stops non-members at a join prompt (fail-open on API
  errors, so nobody is ever locked out); *Daily streak* (`streak`) — UTC-day
  return counters with records (`{{streak}}`, `{{streak_best}}`) that reset
  after a missed day; *Milestone* (`milestone`) — celebrate exactly once
  when a counter first reaches a value (3/5/10/25 invite tiers, quiz
  master, …).
- **All fleet bots rebuilt as growth machines**: the Referral
  Ambassador got a 4-tier reward ladder; the Giveaway's entry is now
  **join-gated** (every entrant must join your public announcements channel
  — configure `NURAE_CHANNEL_URL` as a `t.me/<name>` link); Trivia and the
  Community Hub run daily check-in streaks; every fleet bot greets new
  members in groups and carries one-tap share/referral loops.
- **Group automation**: the moment a fleet bot is added to a group or
  channel it arms ONE daily engagement post for that chat (idempotent,
  posting hour staggered per chat). User-owned bots are never auto-armed.
- **Fleet template versioning**: fleet rows upgrade in place when the
  built-in configurations improve — tokens and AI keys always preserved.

**Official bot fleet (05.001) — the built-in bots, seeded to run**
- The five built-in promotion bots now ship as **platform-owned bot rows**
  inside the "NURAE Official" project — NURAE Referral, Giveaway, Trivia,
  Support and Community Bot, seeded next to NURAE CS Bot (idempotent,
  self-healing, never overwrites admin edits). The admin dashboard's
  "NURAE bot fleet" card lists them all with token/runtime state.
- To run one on Telegram: open it from the fleet card (or Projects →
  NURAE Official), paste a token from @BotFather, start. Fleet bots are
  platform-owned (ownerId null) and therefore **unmetered** — the platform
  does not bill itself.
- Their growth hooks point at `NURAE_SITE_URL` with the platform's own
  referral code (`NURAE_REFERRAL_CODE`, default `nurae`). Seeding needs a
  site URL: set at boot from env, or completed lazily on the first
  dashboard load (request origin fallback).

**Pay-as-you-use billing (05.000) — usage, not subscriptions**
- **Per-feature metering over an integer micro-dollar ledger** (`1,000,000 µ$ = $1`).
  Every metered event — free, trial, premium or charged — writes a `LedgerEntry`
  row (the same journal powers analytics, daily quotas and the /billing ledger
  view). Prices live in the `PricingRule` table, seeded from the compiled
  catalog (`src/lib/nurae/billing/catalog.ts`), editable live via the admin API.
- **The price book**: bot AI reply $0.0015 (free: 50/day), NURAE assistant turn
  $0.002 (25/day), agent builder round $0.005 (10/day), bot message sent
  $0.00005 (500/day), broadcast per recipient $0.0001, hosted bot $0.01/day,
  file upload $0.002/MB (20 MB/day). **Bring your own provider key → bot AI
  replies are free.**
- **Free week + free tier**: every signup gets a 7-day free server week
  (`trial_ends_at`, granted at both the email and Google signup paths); after
  that each feature keeps its free daily allowance (midnight UTC reset).
  Referral "premium days" (the existing entitlement primitive, now finally
  consumed) make ALL usage free while they last.
- **Enforcement without cruelty**: platform AI features hard-gate with an
  honest 402-style message + top-up CTA; bot traffic fails *silently skip* —
  the send is not made, a `BILLING_SKIP` log explains why, the bot resumes the
  instant balance exists. Billing infrastructure errors fail OPEN (never take
  a conversation down). Broadcasts stop mid-fan-out with an honest lastError;
  scheduled sends fail with "Out of credits". Three distinct unpaid hosting
  days stop a bot (webhook deleted, status detail explains); nothing is ever
  deleted.
- **Topups — Telegram Stars**: `createInvoiceLink` on the official platform bot
  (new adapter method); the buyer pays inside Telegram and the
  `successful_payment` update (payload `nurae_topup_<orderNo>`, platform-owned
  bots only) credits the wallet idempotently. Rate env `NURAE_STARS_RATE_MICROS`.
- **Topups — crypto**: manual flow always available (per-asset deposit
  addresses from `NURAE_CRYPTO_ADDRESS_*`, unique order reference, tx-hash
  submission, admin approval queue at `/api/admin/billing/orders`), plus an
  optional auto rail via @CryptoBot Pay (`NURAE_CRYPTOBOT_API_TOKEN`, USD
  invoices credited by the 60 s poller — UNTESTED against the live API).
  Assets: TON (Gram), BTC, USDT, ETH, LTC, TRX. Admin grants + live price
  tuning: `/api/admin/billing/grant`.
- **UI**: public `/pricing` (catalog-rendered price table, free week, payment
  methods, subscription comparison, FAQ) and authed `/billing` (balance,
  trial/premium banner, Stars presets + crypto topup flow incl. tx-hash
  submission, usage-today, price book, topup history, full ledger). Nav updated
  in both shells.
- **BR-020 closed (again, for real)**: the Preview `/test` route — twice
  claimed shipped, twice absent from the commit — now exists AND is covered by
  an ecosystem test that imports it, so it cannot silently vanish again.

The 04.000 release (built-in bots + growth hooks) is described in the release
notes below and remains fully in force.

<details><summary><strong>04.000 — built-in bots: the growth release (previous)</strong></summary>

### IMPLEMENTED

**Built-in bots + growth hooks (new in 04.000) — every deployed bot grows NURAE**
- **Five built-in bots** ship with the platform and instantiate in one click from
  the `/bots` "Built-in bots" section: **Referral Ambassador** (personal invite
  links, invite counters, top-referrers leaderboard), **Giveaway Bot** (one-tap
  entry, live `/draw` winner announcement), **Daily Trivia** (scored quizzes with
  instant feedback + leaderboard), **Support & FAQ** (canned answers, question
  intake into the Audience table, AI fallback), **Community Hub** (subscription
  flag, broadcasts pairing, one-tap sharing). Each arrives fully configured — the
  owner connects a @BotFather token and it runs; every behavior stays editable.
- **Growth hooks baked in**: every template ends with an *About NURAE* flow and
  its welcome links to `https://<site>/?ref=<ownerCode>` — the platform referral
  loop, so the bot's audience becomes NURAE signups while the owner earns premium
  days. Site URL resolves from `NURAE_SITE_URL` → `NURAE_PUBLIC_URL` → the
  request origin; community/channel shortcuts appear when
  `NURAE_COMMUNITY_URL` / `NURAE_CHANNEL_URL` are set.
- **Promotion primitives** (the runtime additions the templates stand on, usable
  by any bot): **remember** steps (silently set or numerically *add to* an
  attribute — counters, entries, scores), **draw** steps (random winner among
  users holding an attribute, announced with `{{winner_name}}/{{winner_chat}}/
  {{count}}`, honest empty state), **top** steps (leaderboard ranked by a numeric
  attribute with a limit).
- **Placeholder upgrades**: `{{bot_username}}` (bare, link-ready, resolved from
  the live Telegram record), fallback syntax (`{{score|0}}`), and **templated
  copy/link buttons** — a personal invite link is literally
  `https://t.me/{{bot_username}}?start=ref_{{chat_id}}` inside a copy button.
- **Built-in invite credit**: `/start ref_<chatId>` payloads automatically credit
  the inviter (`invites` counter +1, joiner remembers `invited_by`, self-referral
  and unknown ids ignored) — the referral-bot convention, now platform-native.
- Display names are remembered per chat, so draws and leaderboards greet people,
  not ids. The behavior editor writes/edits all three new steps in plain language;
  the builder agent's prompt knows the full promotion vocabulary.
- `POST /api/my/bots/from-template` creates the bot (session identity, compiled
  through the same validated path as agent builds). Templates are regression-
  guarded: every template must compile against the real behavior compiler.
- Honest fix note: the Preview-console route claimed fixed in V00.03.000 (BR-019)
  had never actually been committed — the file did not exist; it really ships now
  (BR-020).

**The ecosystem release (03.000) — bots that do real work**
- **Per-user memory** (`bot_user_states`): every chat has persistent attributes.
  A behavior step can **ask and remember** (collect step): the flow pauses, the next
  text answer is stored, and the flow resumes — multi-turn forms, carts, intake.
  Collected values render anywhere via `{{placeholders}}` (built-ins: `{{name}}`,
  `{{username}}`, `{{chat_id}}`; the AI sees the user's facts too).
- **Outbound media**: photo / video / audio / voice / animation / document / sticker
  by HTTPS URL or Telegram `file_id`, with captions + buttons; albums via `sendMediaGroup`.
- **Polls & quizzes** (`sendPoll`, quiz mode with correct answer + explanation);
  answers land on the voter's state (`poll_<id>` attribute).
- **Telegram Stars payments** for digital goods (the mandatory rail): a payment step
  sends an XTR invoice → `pre_checkout_query` answered within the 10 s window →
  `successful_payment` recorded in a dedicated ledger (`bot_payments`, unique
  `charge_id`) → `paid_<payload>` attribute + automatic delivery text. `/terms`,
  `/paysupport`, `/support` are compiled in automatically for any bot that sells
  (Stars store-policy compliance) unless the builder defined them.
- **Scheduler** (`bot_schedules`): reminders and drip content. A behavior step can
  **set a reminder** — the bot parses “water the plants tomorrow at 9am” with its own
  AI into a strict UTC datetime and schedules the send; failures answer honestly and
  let the user retry. Recurring schedules (daily/weekly) re-arm at the same time (UTC).
- **Broadcasts** (`bot_broadcasts`): one message to every chat that ever wrote to the
  bot — newsletters, announcements. Claimed atomically (no double-send across
  workers), paced at ~20 msg/s under Telegram's limits, 429-aware, honest
  sent/failed counters.
- **The task engine** (`runtime/tasks.ts`): a 60 s in-process ticker for long-lived
  deployments plus a fire-and-forget sweep after every webhook update (serverless
  safe) executes due schedules and queued broadcasts.
- **Groups**: `member_joined` trigger for welcomes (name-aware `{{name}}`), commands
  aimed at other bots ignored (`/cmd@OtherBot`), free text in groups answered only
  when the bot is @mentioned (privacy-mode-safe), `my_chat_member` tracking (block
  detection), `chat_member` + `poll_answer` in the update allow-list.
- **Deep links routed**: `/start <payload>` matches payload behaviors (exact or
  prefix) and is stored on the user's state — referral attribution and bind-a-chat
  flows are real now.
- **Reply keyboards & friends**: buttons can render as a reply keyboard (taps send
  the label as text; compiled to exact-text rules), `force_reply`, keyboard remove,
  and **edit-in-place** (`edit: true` edits the pressed message — the idiomatic UX
  for pagination/settings).
- **Button variety**: `web_app` (Mini App links), `copy_text`, plus url/callback/flow/AI.
- **Inline mode**: `@bot query` anywhere answers with the bot's static menu content
  (`answerInlineQuery`, personal, 30 s cache).
- **Typing indicator** before every AI turn (`sendChatAction`), edit-in-place support
  in the sender, `setMyName/setMyDescription/setMyShortDescription` for the public profile.
- **Six new agent tools** (18 total): `bot_set_profile`, `bot_list_users`,
  `bot_broadcast` (approval-gated), `bot_schedule_message` (create/cancel),
  `bot_list_schedules`, `bot_payments_list`. Tool results now feed structured data
  back to the model. The builder prompt carries the capability map + a blueprint
  library (support desk, shop, booking form, reminder bot, newsletter, event bot,
  group welcome, quiz) — pattern-matching, not generic shells.
- **One update router**: webhook and polling share `routeBotUpdate` — polling
  previously dropped callback queries entirely (fixed); every new update family is
  in `allowed_updates` explicitly.
- **Owner surfaces** in `/bots/[id]`: Audience (who talks to the bot and what it
  remembers), Broadcast (queue + live progress), Schedule (pending reminders,
  cancel), Payments (Stars ledger). The Behavior editor writes every new step type
  (media, poll, Stars payment, ask-and-remember, reminder) in plain language.
- Fixed on the way: the **Preview console route** (`POST /api/my/bots/[id]/test`)
  had been missing since 02.001 — the console hit a 404 on every run (BR-019;
  though see BR-020 — the 03.000 fix itself failed to ship and landed in 04.000).

**Behaviors — the primary concept of bot building (02.001)**
- A **Behavior** is the source of truth: “when someone starts the bot, welcome them
  with buttons for Menu, Order, Contact”. The compiler (`src/lib/nurae/bots/behavior.ts`)
  derives the executed configuration (menu commands, reply rules, inline keyboards,
  callback wiring) from behaviors — the technical layer stays real, just not the
  language people build in.
- Plain-language triggers: someone starts the bot / types a command / mentions a word /
  presses a button / anything else. Plain-language button actions: **show a message**,
  **open a link**, **start a flow** (another behavior — the callback wiring is automatic),
  **ask the AI** (the turn goes to the bot's model with guidance). AI steps can appear
  anywhere in a flow.
- The Bot Builder agent builds through `bot_set_behaviors` — intent in, compiled config
  out. Its prompt is intent-first: speak in outcomes, ask one concise question when
  ambiguous, proactively create the pieces a request implies (a button that starts a flow
  gets its target behavior created in the same call). Raw `bot_set_commands` /
  `bot_set_replies` remain as marked ADVANCED escape hatches.
- `/bots/[id]` leads with the **Behavior** editor (when → then, plain language), then
  **Preview** — the real pipeline captured, buttons clickable — then configuration;
  the raw command/reply editors live under an *Advanced* disclosure with an honest note
  that the next behavior save recompiles. Bots configured the old way get a one-click
  **Import current configuration as behaviors** (derive → compile round-trip tested).
- Custom `/start` welcome: a start behavior replaces the built-in text. Fixed:
  `kind: "ai"` menu commands now actually run the model
  (they previously fell through to “Unknown command”).

**Product surfaces**
- Redesigned application chrome: one 48px hairline header — compact text navigation,
  the account menu (sign out lives behind it, not as a giant button), the small N mark
  top-right, a proper mobile sheet menu. Public pages and the authenticated app share
  the identity but not the layout (app pages run full-height, footer-free).
- `/chats` — full-page conversation environment: session sidebar (desktop) / drawer
  (mobile), new/rename/archive/delete chats, typography-led messages (no giant
  bubbles), markdown + GFM rendering, auto-growing composer with Enter/Shift+Enter,
  file attach chips, honest loading/error states, human empty state.
- `/chats/agents` — the agent workbench, **workflow-identical to chat**: persistent agent
  sessions with durable task state, the same sidebar actions (rename/archive/delete),
  the same composer rules, **file attachments** (ownership-checked, merged into the
  session's file refs), optimistic sends with honest rollback on error, activity feed
  sourced from the audit trail, "Approve & publish" control, deep link into the built bot.
- `/bots` — list + create (**“What do you want your bot to do?”** describe-first via the
  agent, or start from scratch), bot detail with behaviors, preview, configuration
  (provider/model/prompt/limits, token + key write-only fields), advanced command/reply
  editors, **real-pipeline preview console**, publish/unpublish with explicit
  confirmation, archive/delete.
- `/featured` — small featured-conversation page; curated questions prefill a new chat.
- Home redesigned: typographic hero, statement-based features, referral capture
  (`?ref=CODE` stored until sign-up), Google/email auth.
- `/about` duplicate footer fixed; `/help` updated to the new product model.

**Chat → Agent routing**
- The chat AI answers questions directly and detects build/modify requests; on
  handoff NURAE continues the user's latest agent session (one ongoing build
  workspace — no parallel threads or duplicate draft bots), seeds it with the task
  and referenced files **by reference** (no re-upload), runs the agent's first turn,
  and offers [Open in Agent]. Files attached in the chat are visible to the agent
  through `files_list` and the system prompt.

**One workflow, one database (new in 02.002)**
- Production no longer forks your data. The standalone server used to chdir into
  `.next/standalone` and silently open a build-time SNAPSHOT of the SQLite database
  (plus a second secret key and forked uploads) — bots worked in dev and died in
  production. All data paths now resolve against the project root
  (`src/lib/paths.ts`), `npm run start` boots through a launcher that pins
  `NURAE_APP_ROOT` + an absolute `DATABASE_URL` and loads the project `.env`, and the
  build script strips `db/`, `.env` and uploads out of the deployable output.
  Verified end-to-end in production mode: publish → Telegram webhook → behavior
  replies + AI turn.

**Files**
- Upload API (multipart, ownership-checked, 10 MB cap, extension allowlist) with
  dependency-free text extraction: text/MD/CSV/JSON inline, **PDF** (zlib stream
  parsing + text operators), **DOCX** (ZIP inflate + `w:t` runs); images and
  unreadable binaries are stored and reported honestly as binary.
- Retrieval is bounded: files enter model context as head+tail slices with the middle
  elided — documents are never dumped wholesale.

**Telegram**
- Custom menu commands (`setMyCommands` on start; static or AI-guided responses).
- Inline keyboards + **callback queries** (`answerCallbackQuery`, namespaced
  `r:` callback data, unknown-callback honesty).
- Reply rules: command / keyword / button / fallback triggers; multi-message
  **mini-workflows**; buttons on the first message of any rule.
- Media: photo messages read the caption (no vision model — documented, honest).
- Deep-link start payloads logged; markdown → Telegram HTML with chunking and
  plain-text fallback everywhere.

**Referrals + entitlements**
- Lazy per-user invite codes; pending reward at sign-up; qualification at email
  verification; 2-day `premium` entitlement granted to the inviter (extending an
  active one). Entitlements are per-feature with expiry — future rewards (extra agent
  runs, storage, models) fit without migration. All server-side; unique-index guards
  against duplicate claims.

**Carried from V00.01.x (unchanged, still real)**
- Webhook (primary) + polling (local) transports; per-bot webhook secrets.
- Provider-agnostic AI layer (OpenRouter free default, OpenAI/DeepSeek/GLM/local/custom),
  credential validation, retries, error classification.
- Secrets encrypted at rest (AES-256-GCM), never returned by APIs, never logged.
- Customer auth (scrypt, Gmail OTP with hashed codes, Google OAuth), sessions.
- Structured logs with event codes; bot status state machine enforced in the DB.
- 239 tests (vitest), lint-clean src, type-clean src.

</details>

### NOT in this release (do not assume these exist)

- Streaming responses (`sendMessageDraft`); Rich Messages; vector search/RAG (file
  knowledge currently distills into the bot prompt, ≤3000 chars per
  `bot_add_knowledge` call); Mini App hosting + `initData` validation (web_app
  buttons link out, NURAE does not host apps yet); group moderation/admin actions;
  Stars refunds via UI (the adapter method exists, no owner control yet); inline
  mode toggle is BotFather-side; games/sticker-pack APIs; Business/Secretary mode;
  Managed Bots; multi-step visual workflow editor; additional agents (the registry
  has exactly one real agent); Discord/WhatsApp channels; horizontal scaling
  guarantees (duplicate-update suppression and broadcast claims are per instance
  for broadcasts; schedule claims are DB-atomic).
- The bot AI time parser assumes UTC unless the user names a timezone — honest,
  documented behavior.

## 5. Architecture

```text
   Browser (App Router pages: / /chats /chats/agents /bots /featured /help /about /admin)
        │  fetch /api/* (relative, cookie sessions)
        ▼
   ┌───────────────────────────────────────────────┐
   │  Next.js (:3000)                              │
   │  API routes ── zod validation ── session auth │
   │     │ chats │ files │ agents │ my/bots │ …    │
   │     │                │                        │
   │     │        Tool layer (tools.ts)             │
   │     │        identity · ownership · audit     │
   │     │                │                        │
   │     │        Bot Builder agent loop           │
   │     │                │                        │
   │  Shared bot pipeline (transport-agnostic):    │
   │  commands → buttons/callbacks → workflows →   │
   │  memory → AI provider → reply (HTML+fallback) │
   │     │                                         │
   │  /api/telegram/webhook/{botId} ◀── Telegram   │
   └──────┬────────────────────────────────────────┘
          │
   libSQL database (Prisma driver adapter) — local file: or Turso libsql://
   Tables: Project Bot Conversation Message Log User Session VerificationToken
           SiteSetting ChatSession ChatEntry AgentStep UserFile Referral
           ReferralReward Entitlement
```

Key boundaries: `AIProvider` · `TelegramAdapter` · `handleBotMessage`/
`handleBotCallback` pipeline · `RuntimeStore` · `ToolSpec` registry ·
`runBotBuilderTurn` · `chatTurn` · `SecretManager` · `referral` entitlement gates.

## 6. Requirements

- [Node.js](https://nodejs.org) 20+ (npm included)
- Per user bot: a Telegram bot token from [@BotFather](https://t.me/BotFather)
- AI: an [OpenRouter](https://openrouter.ai) key (free tier works; `openrouter/free`
  is the default model) — one platform key powers chat + agents
- Gmail app password (customer verification mail) — `NURAE_GMAIL_USER` /
  `NURAE_GMAIL_APP_PASSWORD`
- On Vercel: a [Turso](https://turso.tech) database (free tier works)

## 7. Installation (local development)

One command — everything (Node.js, `.env` with generated secrets, database,
build, start) is automatic:

```bash
git clone https://github.com/akikfaraji/NURAE.git && cd NURAE
bash setup.sh             # modes: full (default) | dev | start | env
```

Manual equivalent:

```bash
npm install
cp .env.example .env     # then edit .env (§8)
npm run db:push          # create/sync the local libSQL database
npm run dev              # single process: site + API + agents + runtime
```

The full self-hosting manual (Termux Debian, own server, systemd + TLS) is
[SETUP.md](./SETUP.md).

## 8. Environment variables

The complete annotated reference is [`.env.example`](./.env.example). Core variables:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | SQLite file (`file:./db/custom.db`) · `libsql://…` (Turso) |
| `NURAE_SECRET_KEY` | Master key for encrypting tokens / keys / webhook secrets |
| `NURAE_ADMIN_TOKEN` | When set, `/admin` + admin API require this token |
| `NURAE_BOT_TRANSPORT` | `webhook` (default) or `polling` (local testing) |
| `NURAE_PUBLIC_BASE_URL` | Public HTTPS origin used for webhook registration |
| `NURAE_GMAIL_USER` / `NURAE_GMAIL_APP_PASSWORD` | Gmail SMTP for verification codes |
| `NURAE_GOOGLE_CLIENT_ID` / `NURAE_GOOGLE_CLIENT_SECRET` | Google sign-in (redirect `<origin>/api/auth/google/callback`) |
| `OPENROUTER_API_KEY` … | Optional per-provider key fallbacks (chat, agents, bots) |
| `NURAE_TELEGRAM_API_BASE` | Testing only — point the adapter at a mock server |

## 9. Database

Entities (see `prisma/schema.prisma`): `Project`, `Bot` (now with `ownerId`,
`commands_json`, `replies_json`, `archived`), `Conversation`, `Message`, `Log`,
`User`, `Session`, `VerificationToken`, `SiteSetting`, plus the product layer:
`ChatSession`, `ChatEntry`, `AgentStep`, `UserFile`, `Referral`, `ReferralReward`,
`Entitlement`.

```bash
npm run db:push          # apply the schema locally
```

Turso (remote `libsql://` cannot be pushed directly):

```bash
node node_modules/prisma/build/index.js migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script \
  | turso db shell $DATABASE_URL
```

## 10. A typical first session

1. Sign up at `/` (or use Google) → verify the 6-digit code (check spam).
2. In **Chats**, ask "What can NURAE do?" — or attach a restaurant-menu PDF and say
   *"Make me a Telegram bot using this."*
3. The chat hands the task to the **Bot Builder agent** — press **Open in Agent**.
4. Watch the activity feed (✓ Created bot ✓ Added commands …), then **Approve &
   publish** when you are ready (publishing needs the bot's Telegram token and an
   HTTPS origin — the agent will ask).
5. Open the bot under **Bots**: edit commands/buttons, press things in the **test
   console**, then publish for real. Message the bot on Telegram.

## 11. Testing

```bash
npm test                 # 226 tests across 14 files (vitest)
npm run lint             # ESLint
```

The suite covers: FRAZIYM version format, secrets, sanitizer, AI providers (mocked
HTTP), Telegram adapter error mapping, the pipeline (built-in + custom commands,
memory, AI failure recovery), webhook receiver (secret verification, duplicates),
API endpoints, the platform layer (registration → verification → sessions, official
bot, settings), Telegram markdown → HTML, and the product layer: bot capabilities
validation + corrupt-row resilience, the tool registry (descriptors, ownership,
confirmation gating, audit rows, argument validation), the Bot Builder agent (JSON
envelope parsing, full tool-executing turn, invalid-output degradation, cross-user
isolation), chat sessions (CRUD ownership, platform-AI turns, handoff with files by
reference, foreign-attachment rejection), file extraction (text/CSV, PDF plain +
zlib, DOCX ZIP, binary honesty, bounded retrieval), user bots (draft creation,
token validation, the real-pipeline test console, deep links, photo captions,
callback honesty), and referrals (full flow, self-referral/unknown/duplicate guards,
entitlement extension).

## 12. Vercel deployment (optional)

1. Create a Turso database + auth token; apply the schema (§9).
2. Import the repo in Vercel; set `DATABASE_URL` (`libsql://…`), `DATABASE_AUTH_TOKEN`,
   `NURAE_SECRET_KEY`, `NURAE_ADMIN_TOKEN`, and the AI/Gmail/Google keys. Leave
   `NURAE_BOT_TRANSPORT` unset (webhook default).
3. Deploy. Publishing a user bot registers
   `https://your-app.vercel.app/api/telegram/webhook/{botId}` with Telegram.

Note: uploaded binaries live on the server filesystem — on Vercel this is ephemeral;
extracted text (what agents and chats actually read) is durable in the database.

## 13. Status of this release's verification

| Layer | Status |
| --- | --- |
| Unit/integration suite (325 tests, incl. the operator agent + agent docs/templates layers) | PASS (local) |
| Type check (`src/` + tests via tsc) | PASS (pre-existing examples/scripts exclusions) |
| ESLint (`src/`) | PASS |
| Production build (`next build`) | PASS |
| Browser verification (desktop + mobile, all pages, auth + ownership) | PASS (see worklog) |
| Real Telegram round trip with a user token | MANUAL — run the test console or a real bot |
| Live SMTP invitation round trip | MANUAL — configure `NURAE_GMAIL_*`, opt in via the Invite Bot |

## 14. Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| Verification code never arrives | Check spam/Promotions; newest code wins; 15-min expiry |
| Start fails with "Telegram rejected… 401" | Bot token invalid — re-check @BotFather |
| Start fails with "No public base URL…" | Set `NURAE_PUBLIC_BASE_URL` to your HTTPS origin (or polling locally) |
| Agent says the AI layer has no key | Platform AI key missing — set it on the official bot (`/admin`) or `OPENROUTER_API_KEY` |
| Operator tool call returns "reserved for the platform operator" | The request lacks the admin token — log in to the dashboard or send `Authorization: Bearer <NURAE_ADMIN_TOKEN>` |
| Publish fails for a user bot | The bot needs a Telegram token + an HTTPS public origin |
| Stored token "could not be decrypted" | `NURAE_SECRET_KEY` changed — re-enter the bot's secrets |
| PDF file shows as binary | The PDF uses an exotic encoding — extraction refused to guess; the file is still stored |

## 15. Current limitations

- The Operator cannot enter secrets (Telegram tokens, AI keys) — those stay
  human-only in the dashboard; it sees WHETHER they exist, never their values.
  Bot start/stop lifecycles are also dashboard work this release.
- File knowledge is prompt-distilled (bounded), not vector-searched.
- Photo messages: caption-only (no vision model).
- Duplicate-update suppression is per instance (see §4).
- Referral rewards are per invited user id; multiple accounts of the same person are
  not fingerprinted (documented, deliberate scope).
- `maxDuration` of the webhook function is capped (60 s) on Vercel Hobby.

---

## 16. Telegram platform research

`docs/telegram/` carries the platform knowledge base that keeps NURAE's
bots specific instead of generic:

- [`PLATFORM.md`](./docs/telegram/PLATFORM.md) — the full Telegram Bot
  platform surface as of Bot API 10.3 (Aug 2026): update types, messaging,
  interaction primitives, monetization, mini apps, AI-native features,
  limits, ops, anti-patterns.
- [`COMMUNITY.md`](./docs/telegram/COMMUNITY.md) — the ecosystem taxonomy:
  what bots people actually build (16 categories, named examples),
  distribution playbooks, failure patterns.
- [`NURAE.md`](./docs/telegram/NURAE.md) — the mapping: NURAE's verified
  capability surface, a 22-item gap analysis with priorities, a 22-blueprint
  library for the builder agent, and the anti-generic agent preparation
  rules.

---

NURAE V00.09.000-beta-03 · FRAZIYM TECH & AI · Autonomous Digital Operations System
