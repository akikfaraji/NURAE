# NURAE

**NURAE — Autonomous Digital Operations System**
**FRAZIYM TECH & AI**

NURAE is an autonomous digital-operations platform that is being built incrementally.
Its long-term ambition is to create, deploy, operate, monitor, and improve digital
services with minimal human intervention. This repository currently contains the
**first, intentionally minimal foundation** of that vision — nothing more, by design.

---

## 1. What NURAE is

NURAE is a platform where an operator can:

1. Create a project.
2. Create an **AI-powered Telegram bot**.
3. Configure the bot (identity, AI provider, model, system prompt, generation settings).
4. Select an AI provider and model (provider-agnostic architecture).
5. Provide a Telegram bot token (stored encrypted).
6. **Start / stop / restart** the bot.
7. View its **status** and **logs**.
8. Modify its configuration at any time.

The current release implements exactly this loop — reliably — and nothing else.

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
| `V00.00.000-beta-01`    | Initial beta (this release)                      |
| `V00.00.001-beta-02`    | Bug fix + second beta revision                   |
| `V00.01.000-beta-01`    | New feature within generation 00                 |
| `V00.01.003-beta-04`    | Feature release, 3 bug fixes, 4th beta revision  |
| `V01.00.000-beta-01`    | New platform generation                          |
| `V01.00.000`            | Stable release (stage omitted)                   |

The **single authoritative version source** is
`src/lib/nurae/version.ts` (`NURAE_VERSION`). Every component — dashboard, API,
runtime startup banner, health endpoint, logs, release metadata — imports the
version from there. Do not duplicate version strings elsewhere.

## 3. Current release

**NURAE V00.00.000-beta-01** — the first NURAE pre-release.

> «Small release. Real functionality. Clean architecture. Continuous evolution.»

## 4. Current scope

### IMPLEMENTED

- Dashboard (responsive single-page console): overview stats, projects, bots,
  configuration editor, live logs.
- REST API (Next.js App Router) with zod input validation on every endpoint.
- Isolated **bot runtime process** (independent of the dashboard/API process):
  multiple bots run simultaneously; one failing bot never crashes others.
- **Telegram integration**: token verification (`getMe`), webhook conflict
  cleanup (`deleteWebhook`), long-polling, `/start`, `/help`, unknown-command
  handling, plain-text messages, AI replies, structured error handling.
- **Provider-agnostic AI layer** (`AIProvider` interface + registry):
  - `zai` — GLM via the built-in SDK (zero configuration, works out of the box)
  - `openai`, `openrouter`, `deepseek`, `glm` (Zhipu), `local` (Ollama/vLLM),
    `custom` — all through one OpenAI-compatible HTTP implementation
  - Credential validation, timeouts, classification of errors, bounded retries
    with backoff, `Retry-After` support
- **Short-term conversation memory**: configurable number of recent messages
  kept per chat (no vectors, no RAG).
- **Secrets**: Telegram tokens and AI API keys encrypted at rest
  (AES-256-GCM, key from `NURAE_SECRET_KEY` or an auto-generated key file);
  never returned by any API, never logged (log sanitizer redacts credential
  patterns at write *and* read time).
- **Admin authentication**: set `NURAE_ADMIN_TOKEN` to require an admin token
  for the dashboard and all administrative endpoints.
- **Persistence**: SQLite via Prisma (WAL mode, safe multi-process access),
  schema shaped for a future PostgreSQL migration.
- Health endpoint, structured logs, graceful shutdown, automated tests.

### PLANNED (NOT in this release — do not assume these exist)

Discord / WhatsApp / Web channels, RAG, vector databases, embeddings, long-term
memory, voice or image generation, agent swarms, autonomous self-programming,
marketplace, billing, payments, cryptocurrency, Kubernetes, multi-region
infrastructure, self-modifying code, AGI systems. These are future roadmap
items and are intentionally excluded.

## 5. Architecture

```text
                Browser (SPA at /)
                        │  fetch /api/* (relative paths)
                        ▼
        ┌───────────────────────────────┐
        │   Next.js API layer (:3000)   │  auth guard · zod validation · DTOs
        └──────────────┬────────────────┘
                       │ localhost HTTP (shared internal token)
        ┌──────────────▼────────────────┐
        │  NURAE Bot Runtime (:3030)    │  mini-services/nurae-runtime
        │  BotManager                   │
        │  ├─ BotRuntime A ─ Telegram   │
        │  ├─ BotRuntime B ─ Telegram   │
        │  └─ BotRuntime C ─ Telegram   │
        │        │ each bot:            │
        │   TelegramAdapter → memory →  │
        │   ProviderSelector → AIProvider
        └──────────────┬────────────────┘
                       │
              SQLite (Prisma, WAL) — shared by both processes
```

Key boundaries (kept modular for future releases):
`AIProvider` · `ChannelAdapter` (Telegram only today) · `BotRuntime` ·
`BotManager` · `RuntimeStore` (storage) · `SecretManager`.

The AI request pipeline (spec §16):

```text
Telegram message → Telegram Adapter → Bot Runtime → Bot Configuration
→ Provider Selector → AI Provider → AI Response → Telegram
```

Provider-specific code never leaks into Telegram-specific code.

## 6. Requirements

- [Bun](https://bun.sh) 1.1+ (JavaScript/TypeScript runtime + test runner)
- A Telegram bot token from [@BotFather](https://t.me/BotFather) (per bot)
- For the built-in `zai` provider: nothing — it works out of the box
- For external providers: an API key for the chosen provider

## 7. Installation

```bash
bun install              # install dependencies
cp .env.example .env     # then edit .env (see §8)
bun run db:push          # create/sync the SQLite database
```

## 8. Environment variables

See [`.env.example`](./.env.example) for the full annotated list:

| Variable                   | Purpose                                                                 |
| -------------------------- | ----------------------------------------------------------------------- |
| `DATABASE_URL`             | SQLite file location (`file:./db/custom.db`)                            |
| `NURAE_SECRET_KEY`         | Master key for encrypting bot tokens / API keys at rest                 |
| `NURAE_ADMIN_TOKEN`        | When set, dashboard + admin API require this token                      |
| `NURAE_RUNTIME_PORT`       | Port of the bot runtime service (default `3030`)                        |
| `NURAE_RUNTIME_TOKEN`      | Shared internal token between API and runtime (auto-generated if unset) |
| `OPENAI_API_KEY` …         | Optional per-provider key fallbacks                                     |

## 9. Database setup

```bash
bun run db:push          # apply prisma/schema.prisma to the SQLite file
```

Entities: `Project`, `Bot`, `Conversation`, `Message`, `Log` (see
`prisma/schema.prisma`). SQLite is acceptable for this release; the model uses
standard columns/relations only, so a PostgreSQL migration later is
straightforward. WAL journal mode + busy-timeout make concurrent access by the
API process and the runtime process safe.

## 10. Running NURAE

Two processes are required (this is intentional — the dashboard must not
depend on the bot runtime):

```bash
# 1) Bot runtime (owns running Telegram bots)
bun run --cwd mini-services/nurae-runtime dev

# 2) Dashboard + API (Next.js on :3000)
bun run dev
```

On startup the runtime prints:

```text
NURAE V00.00.000-beta-01
FRAZIYM TECH & AI
Autonomous Digital Operations System
```

Open the dashboard root URL and you are in the console.

## 11. Creating a Telegram bot

1. In Telegram, talk to **@BotFather** → `/newbot` → choose a name and username.
2. Copy the token (format `1234567890:AA…`).
3. In the NURAE dashboard: **Projects → Create project → Create bot**.
4. Paste the token, pick provider + model, write the system prompt, save.
5. Press **Start**. NURAE verifies the token via `getMe` and begins polling.
6. In Telegram, send `/start` to your bot, then send a normal message.
7. Return to the dashboard to watch status and logs live.

## 12. Configuring AI providers

- **Built-in (`zai`)**: zero setup — GLM through the FRAZIYM built-in SDK.
- **OpenAI-compatible providers** (`openai`, `openrouter`, `deepseek`, `glm`,
  `local`, `custom`): store the API key on the bot (encrypted) or provide it
  via the matching environment variable.
- Use **Verify connections** on a bot page to check Telegram identity and
  provider credentials without starting the bot.

## 13. Running multiple bots

Create several bots and start them — the `BotManager` runs them concurrently
in the runtime process, each with its own Telegram long-poll loop and its own
AI provider configuration. Failures are isolated per bot. Stop/restart affects
only the targeted bot.

## 14. Testing

```bash
bun test
```

The suite covers (spec §19): version format, secret vault, log sanitizer,
provider registry/selection/invalid provider/credential errors/timeouts,
Telegram adapter error mapping + command routing, conversation memory,
BotManager lifecycle (start/stop/restart/status/multiple bots), API endpoints
(create project, create bot, update config, start/stop/restart, logs),
and security (secrets never returned, invalid requests rejected,
unauthorized operations rejected). Network-dependent units use mocks.

## 15. Troubleshooting

| Symptom                                    | Likely cause / fix                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| Start fails with “Telegram rejected… 401”  | Bot token invalid — re-check the token from @BotFather                    |
| Start fails with “conflict (409)”          | Another polling session/webhook is active for this token; wait and retry  |
| “No API key configured for provider …”     | Store a key on the bot or set the provider’s env var                      |
| Runtime offline badge in the dashboard     | Runtime process not running — start it (see §10)                          |
| Bot in `error` state                       | Check the bot’s Logs panel; `statusDetail` shows the last error           |
| AI replies stop after provider outage      | NURAE retries with backoff; check logs for `rate_limited` / `timeout`     |
| Login loop on the dashboard                | `NURAE_ADMIN_TOKEN` changed — log in again with the new token             |

## 16. Current limitations

- Telegram only (one channel); the `ChannelAdapter` boundary exists but no
  other adapters are implemented.
- Plain-text Telegram messages only (no markdown/media parsing).
- Short-term memory only (recent-message window per chat).
- SQLite only; no migrations beyond `db:push` in this release.
- Dashboard and runtime are separate processes on one host; `bun --hot` (dev
  mode) restarts the runtime on file changes, which stops running bots.
- Admin auth is a single shared token (adequate for the beta; not a full
  identity system).

## 17. Future roadmap

Kept deliberately out of this release (see §4 — PLANNED): additional channels
(Discord/WhatsApp/Web), streaming responses, RAG and long-term memory,
workflow automation, deployment/monitoring/self-recovery services, and the
broader autonomous-operations vision. The interfaces (`AIProvider`,
`ChannelAdapter`, `BotRuntime`, `BotManager`, `DeploymentManager`, `Storage`,
`SecretManager`) are structured so these can be added without rewrites.

---

NURAE V00.00.000-beta-01 · FRAZIYM TECH & AI · Autonomous Digital Operations System
