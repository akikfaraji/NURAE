# NURAE

**NURAE — Autonomous Digital Operations System**
**FRAZIYM TECH & AI**

NURAE is an autonomous digital-operations platform that is being built incrementally.
Its long-term ambition is to create, deploy, operate, monitor, and improve digital
services with minimal human intervention. This repository currently contains the
**minimal but genuinely functional core** of that vision: a platform that creates,
configures, starts, monitors, and stops AI-powered Telegram bots.

---

## 1. What NURAE is

NURAE is a platform where an operator can:

1. Log into the NURAE console.
2. Create a project.
3. Create an **AI-powered Telegram bot**.
4. Provide a Telegram bot token (stored encrypted).
5. Configure the bot (AI provider, model, system prompt, generation settings, memory).
6. **Start / stop / restart** the bot.
7. Send the bot a message on Telegram and receive an **AI-generated reply**.
8. View its **status** and **structured logs**.

The current release implements exactly this loop — reliably — and nothing else.

> **Setup / self-hosting:** the complete step-by-step manual — local machine
> or Termux Debian, polling vs webhook transport, and serving from your own
> Linux server with systemd + Caddy — lives in **[SETUP.md](./SETUP.md)**.
> All configuration is a single `.env` file (`.env.example` is the annotated
> template). Vercel/Actions split-deployment paths are optional extras.

## 2. FRAZIYM versioning system

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

Examples:

| Version                 | Meaning                                          |
| ----------------------- | ------------------------------------------------ |
| `V00.00.000-beta-01`    | Initial beta foundation                          |
| `V00.01.000-beta-02`    | First feature release — working bot platform (this release) |
| `V00.01.003-beta-04`    | Feature release, 3 bug fixes, 4th beta revision  |
| `V01.00.000`            | Stable release (stage omitted)                   |

The **single authoritative version source** is
`src/lib/nurae/version.ts` (`NURAE_VERSION`). Every component — dashboard, API,
health endpoint, logs, release metadata — imports the version from there. Do
not duplicate version strings elsewhere.

## 3. Current release

**NURAE V00.01.000-beta-02** — the first feature release.

> «Small release. Real functionality. Clean architecture. Continuous evolution.»

## 4. Current scope

### IMPLEMENTED

- Dashboard (responsive single-page console): overview stats, projects, bot
  cards (name, Telegram username, provider, model, status, created), bot
  detail with controls (Start / Stop / Restart / Edit / Logs / Delete / Verify).
- REST API (Next.js App Router) with zod input validation on every endpoint.
- **Telegram integration, webhook transport (primary)**: `setWebhook` on start
  (with a per-bot random secret verified via `X-Telegram-Bot-Api-Secret-Token`),
  `deleteWebhook` on stop, `/start`, `/help`, unknown-command handling,
  plain-text messages, AI replies, Telegram-side status reconciliation
  (`getWebhookInfo`).
- **Polling transport (local fallback)**: in-process long-poll loop for local
  development without a public URL (`NURAE_BOT_TRANSPORT=polling`).
- **Bot status state machine**: `stopped → starting → running → stopping →
  stopped`, with `error` reachable from `starting`/`running`/`stopping`.
  Nonsense transitions are rejected — the check is enforced in the database,
  not just in memory.
- **Provider-agnostic AI layer** (`AIProvider` interface + registry):
  - `zai` — GLM via the built-in SDK (zero configuration, works out of the box)
  - `openai`, `openrouter`, `deepseek`, `glm` (Zhipu), `local` (Ollama/vLLM),
    `custom` — all through one OpenAI-compatible HTTP implementation
  - Credential validation, timeouts, error classification, bounded retries
    with backoff, `Retry-After` support
- **Structured bot logs** with event codes (`BOT_CREATED`, `BOT_STARTING`,
  `BOT_STARTED`, `TELEGRAM_MESSAGE_RECEIVED`, `AI_REQUEST`, `AI_RESPONSE`,
  `TELEGRAM_MESSAGE_SENT`, `BOT_STOPPING`, `BOT_STOPPED`, `BOT_ERROR`, …) —
  never containing tokens, API keys, or other secrets (sanitized at write and
  read time).
- **Short-term conversation memory**: configurable number of recent messages
  kept per chat (no vectors, no RAG).
- **Secrets**: Telegram tokens, AI API keys, and webhook secrets encrypted at
  rest (AES-256-GCM, key from `NURAE_SECRET_KEY` or an auto-generated local
  key file); never returned by any API, never logged.
- **Admin authentication**: set `NURAE_ADMIN_TOKEN` to require an admin token
  for the dashboard and all administrative endpoints (timing-safe comparison).
- **Persistence** via the Prisma libSQL driver adapter: the SAME schema serves
  local development (`file:` — embedded libSQL) and serverless deployment
  (`libsql://` — hosted Turso).
- **Vercel-compatible**: no second process, no long-running loops, no local
  filesystem dependency when `NURAE_SECRET_KEY` + Turso are configured.
- Health endpoint, automated tests (92), lint-clean, type-clean.

### EXPERIMENTAL

- The built-in `zai` provider depends on the FRAZIYM sandbox SDK
  (`z-ai-web-dev-sdk`); it works out of the box in the FRAZIYM environment and
  locally, but production deployments should prefer external providers
  (`openai`, `openrouter`, `deepseek`, `glm`, …).
- Duplicate-update suppression (Telegram retry safety) is per server
  instance; on horizontally scaled deployments a timed-out webhook could
  rarely be processed twice.

### PLANNED (NOT in this release — do not assume these exist)

Autonomous code generation, automatic bot creation from natural language,
marketplace, billing, payments, multi-user teams, complex analytics, RAG,
vector databases, fine-tuning, agent swarms, streaming responses, Discord /
WhatsApp / Facebook / Instagram / Web channels, mobile application, dozens of
additional AI providers. These are future roadmap items and are intentionally
excluded.

## 5. Architecture

```text
                Browser (SPA at /)
                        │  fetch /api/* (relative paths)
                        ▼
        ┌────────────────────────────────────┐
        │      Next.js app (:3000)           │
        │   Dashboard ─ API routes           │  auth guard · zod · DTOs
        │        │                           │
        │   Transport layer                  │  webhook (primary) | polling (dev)
        │        │        └── BotManager ── BotRuntime (in-process poll loop)
        │        │
        │   /api/telegram/webhook/{botId}  ◀── Telegram POSTs updates here
        │        │
        │   Shared pipeline (transport-agnostic):
        │   commands → conversation memory →
        │   Provider Selector → AIProvider → reply
        └───────┬────────────────────────────┘
                │
     libSQL database (Prisma driver adapter)
     local: file:./db/custom.db   |   Vercel: libsql://… (Turso)
```

Key boundaries (kept modular for future releases):
`AIProvider` · `TelegramAdapter` (channel boundary) · `handleBotMessage`
pipeline · `BotRuntime` (polling) · `transport` layer (webhook lifecycle,
state machine, status merge) · `RuntimeStore` (storage) · `SecretManager`.

The message flow (transport-independent):

```text
Telegram → Telegram Adapter → NURAE pipeline → conversation context
→ AI Provider interface → selected provider → response → Telegram
```

No specific AI provider is hard-coded into the pipeline; no Telegram API call
exists outside the Telegram adapter.

### Why webhook is the primary transport (and polling the fallback)

Webhook mode is stateless: Telegram delivers each update as an HTTPS request,
NURAE processes it (AI call included) and responds. That makes the whole bot
runtime compatible with serverless hosting (Vercel), immune to redeploys
(no in-memory state to lose), and more reliable — Telegram automatically
redelivers updates when NURAE fails to acknowledge them. The per-bot
`secret_token` mechanism authenticates every delivery. Polling is kept only
because `localhost` has no public URL for Telegram to call; it refuses to
start on serverless platforms, where it cannot work.

## 6. Requirements

- [Bun](https://bun.sh) 1.1+ (JavaScript/TypeScript runtime + test runner)
- A Telegram bot token from [@BotFather](https://t.me/BotFather) (per bot)
- For the built-in `zai` provider: nothing — it works out of the box
- For external providers: an API key for the chosen provider
- On Vercel: a [Turso](https://turso.tech) database (free tier works)

## 7. Installation (local development)

```bash
bun install              # install dependencies
cp .env.example .env     # then edit .env (see §8)
bun run db:push          # create/sync the local libSQL database
bun run dev              # single process: dashboard + API + runtime
```

## 8. Environment variables

All configuration lives in one `.env` file (`cp .env.example .env`). The
complete annotated reference is [`.env.example`](./.env.example) and the
self-hosting manual ([SETUP.md](./SETUP.md) §3 + §9) explains each value.
Core variables:

| Variable                   | Purpose                                                                     |
| -------------------------- | --------------------------------------------------------------------------- |
| `DATABASE_URL`             | SQLite file (`file:./db/custom.db`) · `libsql://…` (Turso) if you split      |
| `NURAE_SECRET_KEY`         | Master key for encrypting bot tokens / API keys / webhook secrets at rest   |
| `NURAE_ADMIN_TOKEN`        | When set, dashboard + admin API require this token                          |
| `NURAE_BOT_TRANSPORT`      | `webhook` (default) or `polling` (local testing without a public URL)       |
| `NURAE_PUBLIC_BASE_URL`    | Public HTTPS origin used for webhook registration                           |
| `PORT` / `HOSTNAME`        | Standalone server binding (production)                                      |
| `NURAE_TELEGRAM_API_BASE`  | Testing only — point the Telegram adapter at a mock server                  |
| `OPENAI_API_KEY` …         | Optional per-provider key fallbacks                                         |

## 9. Database

Entities: `Project`, `Bot`, `Conversation`, `Message`, `Log` (see
`prisma/schema.prisma`). Locally the database is an embedded libSQL file;
on Vercel it is a hosted Turso database. Both use the same Prisma schema and
the `@prisma/adapter-libsql` driver adapter.

```bash
bun run db:push          # apply the schema to the local file database
```

Applying the schema to a Turso database (remote `libsql://` URLs cannot be
pushed directly by the Prisma CLI):

```bash
bunx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script \
  | turso db shell $DATABASE_URL
```

## 10. Running NURAE

Local development needs a single process:

```bash
bun run dev
```

Open the dashboard root URL and you are in the console.

## 11. Deploying to Vercel (optional — see SETUP.md Part B for self-hosting)

1. Create a Turso database: `turso db create nurae` and note its URL
   (`turso db show nurae --url`) plus an auth token
   (`turso db tokens create nurae`).
2. Apply the schema (§9, Turso command).
3. Push this repository to GitHub and import it in Vercel (framework:
   Next.js — detected automatically; Prisma generates in `postinstall`).
4. Configure the environment variables: `DATABASE_URL` (`libsql://…`),
   `DATABASE_AUTH_TOKEN`, `NURAE_SECRET_KEY` (long random string),
   `NURAE_ADMIN_TOKEN`. Leave `NURAE_BOT_TRANSPORT` unset (webhook default).
5. Deploy, then open `https://your-app.vercel.app`, log in, and create a bot.
6. Press **Start** — NURAE registers `https://your-app.vercel.app/api/telegram/webhook/{botId}`
   with Telegram automatically (the public origin is derived from request
   headers, or set `NURAE_PUBLIC_BASE_URL` explicitly).

Note: Telegram webhooks require an HTTPS origin — Vercel provides one.

## 12. Creating a Telegram bot

1. In Telegram, talk to **@BotFather** → `/newbot` → choose a name and username.
2. Copy the token (format `1234567890:AA…`).
3. In the NURAE dashboard: **Projects → Create project → Create bot**.
4. Paste the token, pick provider + model, write the system prompt, save.
5. Press **Start**. NURAE verifies the token (`getMe`), registers the webhook,
   and the bot shows `running` with the `webhook transport` badge.
6. In Telegram, send `/start` to your bot, then send a normal message —
   you receive an AI-generated reply.
7. Return to the dashboard to watch status and logs live; press **Stop** to
   take the bot offline (webhook removed), **Restart** to reload config.

## 13. Configuring AI providers

- **Built-in (`zai`)**: zero setup — GLM through the FRAZIYM built-in SDK.
- **OpenAI-compatible providers** (`openai`, `openrouter`, `deepseek`, `glm`,
  `local`, `custom`): store the API key on the bot (encrypted) or provide it
  via the matching environment variable.
- Use **Verify connections** on a bot page to check Telegram identity and
  provider credentials without starting the bot.

## 14. Testing

```bash
bun test            # 92 tests across 8 files
bun run lint        # ESLint
```

The suite covers: FRAZIYM version format, secret vault, log sanitizer,
AI providers (mocked HTTP: success, auth failure, timeout, rate limit,
malformed response, retries), Telegram adapter error mapping, the shared
pipeline (commands, memory, AI failure recovery), bot lifecycle state
machine, the webhook receiver (secret verification, full message flow,
duplicate suppression, malformed payloads), API endpoints (projects, bots,
config, lifecycle, logs), and security (secrets never returned, 401s, 422s,
IDOR-resistant error responses). Network-dependent units use mocks — no real
Telegram credentials are required.

An end-to-end driver lives at `scripts/e2e.ts`. It is REAL-only: real
Telegram Bot API, real AI provider, real HTTP chain — no mocks. It drives
the full loop (health → auth gate → create → start → real webhook check via
`getWebhookInfo` → **you send one real Telegram message** → AI round trip
verified through structured logs → stop → webhook removal check → real-401
error path → cleanup) and exits non-zero on any failure.

## 14.1 Gateway Link — static frontend, moving backend (beta-03)

The frontend is deployed **once**; the backend finds it at runtime:

1. The backend boots (with `NURAE_LINK_FRONTEND_URL` + `NURAE_GATEWAY_KEY`)
   and POSTs its public origin to the frontend's
   `POST /api/gateway/register` — shared key (timing-safe compare), HTTPS
   enforced, and the frontend health-checks the endpoint for a real NURAE
   V00-series `/api/health` before accepting. The link is re-registered
   every 60 s (tunnel origins change per boot) and lives in a Vercel Blob
   store.
2. The frontend's middleware proxies every `/api/*` request (except
   `/api/gateway/*`) to the linked backend **at request time** — same-origin
   for the browser, cookies unchanged, no CORS, no rebuild when the backend
   moves. Until a backend links, the API answers `503 backend-not-linked`.
3. `GET /api/gateway/status` exposes whether a backend is linked (host only,
   no secrets); `DELETE /api/gateway/register` unlinks (key required).

One-time Vercel setup: deploy NURAE once → Project → Storage → create a
**Blob store** → Project → Settings → Environment Variables → set
`NURAE_GATEWAY_KEY` (generate with `openssl rand -hex 24`) → redeploy. The
build-time `NURAE_BACKEND_URL` rewrite from beta-02 remains as a fallback
mode (gateway link takes precedence when configured).

## 14.2 Split-deployment E2E workflow (GitHub Actions × Vercel)

`.github/workflows/split-e2e.yml` proves the split architecture with real
services on every manual run (Actions tab → *Split E2E* → *Run workflow*):

```
[Vercel frontend (stable URL, gateway mode)]  ← deployed once, never rebuilt
      │  middleware /api/* runtime proxy → the LINKED backend
      ▼
[trycloudflare tunnel]  ← the only public entry to a GitHub runner
      ▼
[Actions runner]  real backend (:3000, admin auth on) → real api.telegram.org
                  (webhook on the tunnel URL) + real AI provider API
```

Flow: tunnel up → backend boots and **registers itself** with the frontend
→ workflow waits until `/api/gateway/status` reports the tunnel host → the
E2E driver verifies the gateway link, the auth gate over the full chain,
real `setWebhook`/`getWebhookInfo` against Telegram, one REAL message round
trip (a human sends it — Telegram forbids bots from messaging first; the
workflow pauses and prints `👉 NOW: send ANY text message to @bot`), the AI
pipeline via structured log events
(`TELEGRAM_MESSAGE_RECEIVED → AI_REQUEST → AI_RESPONSE → TELEGRAM_MESSAGE_SENT`),
webhook removal on stop, and the real-401 invalid-token path.

Required repository secrets: `TELEGRAM_BOT_TOKEN` (use a **dedicated test
bot** — the workflow overwrites its webhook and removes it at the end),
`AI_API_KEY` (for the chosen provider), and `GATEWAY_KEY` (must equal the
Vercel deployment's `NURAE_GATEWAY_KEY`; `frontend=tunnel-only` skips the
frontend and tests the backend through the tunnel directly).

Known limitations: the tunnel URL is per-run (the Gateway Link heartbeat
absorbs that — that is its job); the round-trip step needs a human at the
keyboard; a `push` trigger is commented out (concurrency + run minutes).

### Status of this release's testing

| Layer | Status |
| --- | --- |
| Unit/integration (incl. gateway registration core) | PASS (local) |
| Rewrite-proxy split chain (health/auth/CRUD/cookie) | PASS (local, real HTTP, beta-02) |
| Gateway Link middleware proxy | IMPLEMENTED — UNTESTED end-to-end (needs Vercel Blob + first run) |
| Split E2E in GitHub Actions (gateway mode) | IMPLEMENTED — UNTESTED (requires one-time Vercel setup + real secrets) |
| Real Telegram delivery from Actions | UNTESTED until first run with secrets |

## 15. Troubleshooting

| Symptom                                        | Likely cause / fix                                                            |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| Start fails with “Telegram rejected… 401”      | Bot token invalid — re-check the token from @BotFather                        |
| Start fails with “No public base URL…”         | Set `NURAE_PUBLIC_BASE_URL` to your HTTPS origin (or run locally with polling) |
| Bot shows “no active webhook”                  | Webhook was deleted out-of-band; start the bot again                          |
| “Polling transport cannot run on serverless…”  | Set `NURAE_BOT_TRANSPORT=webhook` (or run locally)                            |
| “No API key configured for provider …”         | Store a key on the bot or set the provider’s env var                          |
| Bot in `error` state                           | Check the bot’s Logs panel; `statusDetail` shows the last error               |
| Stored token “could not be decrypted”          | `NURAE_SECRET_KEY` changed — re-enter the bot’s secrets                       |
| Login loop on the dashboard                    | `NURAE_ADMIN_TOKEN` changed — log in again with the new token                 |

## 16. Current limitations

- Telegram only (one channel); the adapter boundary exists but no other
  channels are implemented.
- Plain-text Telegram messages only (no markdown/media parsing).
- Short-term memory only (recent-message window per chat).
- Polling transport is local-development only; one NURAE instance should own
  a bot token at a time (Telegram enforces this per token anyway).
- Duplicate-update suppression is per instance (see §4 — EXPERIMENTAL).
- Admin auth is a single shared token (adequate for the beta; not a full
  identity system). Bots are owned by the single admin — there is no
  multi-tenancy yet, so cross-user isolation reduces to authentication.
- `maxDuration` of the webhook function is capped (60 s); extremely slow AI
  providers could exceed it on the Vercel Hobby plan.

## 17. Future roadmap

Kept deliberately out of this release (see §4 — PLANNED): additional channels,
streaming responses, RAG and long-term memory, multi-user teams with per-user
bot ownership, workflow automation, and the broader autonomous-operations
vision. The interfaces (`AIProvider`, `TelegramAdapter`, pipeline,
`RuntimeStore`, `SecretManager`) are structured so these can be added without
rewrites.

---

NURAE V00.01.000-beta-02 · FRAZIYM TECH & AI · Autonomous Digital Operations System
