# NURAE — Current Status & Handoff Guide

> Last verified: 2026-10-20. Every number below was produced by an actual command run on this tree
> (commit `9a69cb8`). Keep this file current — it is the fast-onboarding doc for any agent.

## What this is

NURAE (FRAZIYM) is a Telegram bot platform + customer site in one Next.js app:
Next.js 16 (App Router, React 19) + Tailwind 4 + shadcn/ui + Prisma with the libSQL adapter
(`file:` local dev, `libsql://` Turso on Vercel — one schema, both worlds). Telegram transport is
webhook-first (`/api/telegram/webhook/[botId]`, per-bot secret header) with polling fallback for
localhost. AI runs through an OpenAI-compatible provider registry (openrouter / deepseek / glm /
local / custom) with retries, backoff and key-health probes. There is an external AI-agent API
(`/api/v1/*`, MCP at `/api/mcp`, OpenAPI 3.1 at `/api/openapi.json`) and a two-faced UI: customer
site at `/` (signup with email verification, chat with the official CS bot, billing/pricing views)
and operator console at `/admin`. Version format is FRAZIYM (`V00.xx.xxxx-beta-nn`) in
`src/lib/nurae/version.ts`.

## Current state (as of 2026-10-20)

- **HEAD**: `9a69cb8` "feat(v4): depth unification + auth password reset + bot-tools extraction"
  (61 files). **LOCAL ONLY — push currently denied (403)**: the PAT in the remote URL belongs to
  account `Akik-Forazi`, which has no write access to `github.com/akikfaraji/NURAE`. Owner pushes
  manually. Before it: `9aee920` promotional-mail engine; `e29a646` Super Logger.
- **Gates on this exact tree**: vitest **527/527** (36 files) · `tsc --noEmit` → **0 source
  errors** · `npm run build` exit 0 (per V4-UNIFICATION-REPORT, 2026-10-18).
- Single-process runtime (the old port-3030 mini-service was merged away in beta-02;
  `mini-services/` is an empty `.gitkeep` — do not resurrect it).

## Map — where things live

| Path | Contents |
| --- | --- |
| `src/lib/nurae/*` | Shared core: `version`, `db` (libsql adapter), `paths` (data-home resolution), `secrets` (AES-256-GCM at rest), `sanitize`, `validation` (zod), `logging` (Super Logger, 4 sinks), `state-machine`, `key-health` |
| `src/lib/nurae/ai/*` | Provider registry + retry/backoff + key-health probes (chat-first; `/models` accepts garbage keys, so probe chat) |
| `src/lib/nurae/agents/*` | Agent tools incl. `platform-tools.ts`; bot tooling extracted to `src/lib/nurae/runtime/bot-tools.ts` (+ `tests/nurae/bot-tools.test.ts`) |
| `src/app/api/*` | REST surface: projects/bots CRUD, lifecycle, `/api/auth/*` (login, register, forgot/reset password), `/api/v1/*`, `/api/mcp`, `/api/openapi.json`, `/api/admin/*`, `/api/telegram/webhook/[botId]` |
| `src/components/nurae/*` | Dashboard SPA + site. `depth.tsx` is the V4 scaffold (`PageContainer`, `DepthBackground` variants). `views.tsx` + `bot-view.tsx` are NOT yet V4-restyled (see Open threads) |
| `tests/nurae/*` | Vitest suite (36 files) |
| `scripts/` | `dev.mjs`, `db.mjs`, `start-prod.mjs`, `mock-ai.js`, live probes |
| `.zscripts/` | Agent scratch helpers (`dbprobe.py` etc., `shoot.mjs` capture pipeline) — not product code |
| `docs/` | `PLATFORM-MASTER-PLAN.md`, `business/`, `legal/` (draft policies) |
| Root docs | `V4-UNIFICATION-REPORT.md` (latest UI wave + gaps), `agent-collab.md` (master blueprint), `worklog.md` (per-task history), `README.md`, `SETUP.md` |

## Verification gates (exact commands)

```powershell
cd NURAE
npm test            # vitest run — expect 527/527 across 36 files
npx tsc --noEmit    # expect 0 SOURCE errors (see noise note below)
npm run build       # final gate before shipping
npm run lint
npm run db:push     # schema sync (local file DB)
```

**tsc noise**: a stale generated `.next/dev/types/routes.d.ts` can throw ~80 syntax errors
(TS1005/TS1002…). They are all inside `.next/`, regenerate on the next dev/build, and are NOT
source problems. Filter with `| Where-Object { $_ -notmatch '^\.next' }`. Never edit `.next/`.

**Visual checks**: the AutoClaw browser pane refuses `localhost` (private-target policy). Use the
repo's own CDP pipeline instead:

```powershell
node .zscripts/shoot.mjs http://127.0.0.1:3000 .zshots_v4        # authenticated matrix
node .zscripts/shoot.mjs http://127.0.0.1:3000 .zshots_v4_anon home
# Env: SHOOT_SERVER=1 (own the server lifecycle), TEST_SESS=<session cookie>, SHOOT_BOT_ID=<bot id>
```

## Environment quirks (learned the hard way — read before touching anything)

- **Windows, PowerShell 5.1.** `LOCALAPPDATA` may be UNSET in agent shells; `src/lib/nurae/paths.ts`
  falls back to the homedir, so the DB lives at
  `C:\Users\user\AppData\Local\FRAZIYM\NURAE\db\custom.db` (AppData\Local, never Roaming).
- **Never put `%VAR%` references in `.env`** (Node does not expand them). Structurally guarded now:
  `paths.ts`, `scripts/db.mjs` and `start-prod.mjs` exit(1) with the exact fix.
- **Do NOT set `DATABASE_URL` locally** — leaving it unset lets the data home resolve correctly.
  On Vercel use a `libsql://` Turso URL.
- **Use `PORT`, not `HOST`** for the port (HOST=8723 is dead config). Dev: `npm run dev`;
  prod: `npm start`.
- `.env` is gitignored. Before any commit, secret-scan new files for credential-shaped literals
  (`sk-or-v1…`, `ghp_…`, `NAME=value` token shapes).
- **Workspace write guard**: file writes containing credential-assignment-shaped lines are blocked
  EVEN IF the line is pre-existing text passing through the write. Currently affected:
  `worklog.md` (old burned admin-token literal near line 294 — owner will redact it later) and
  `views.tsx` / `bot-view.tsx` (`needsToken` boolean + credentials readout — false positives).
  Until redacted/renamed, those files cannot be agent-written; use commit messages or a new file
  as the documentation channel. Do not try to bypass the guard with a different tool.

## Conventions

- Conventional commits with a descriptive body; include the test tally (e.g. "vitest 527/527
  (36 files)") in the body. New behavior ships with vitest cases.
- `worklog.md`: one entry per task (Task ID / Agent / Work Log / Stage Summary) — append at the
  bottom. Currently frozen by the write guard (see above); `handoff.md` (this file) is the live
  channel.
- Secrets: AES-256-GCM at rest, never returned by APIs, logs sanitized at write AND read. Stored
  per-bot keys OVERRIDE the `.env` key (owner trap from Task 24 — "the new key doesn't work" meant
  the old stored key was still winning).
- Admin auth via `NURAE_ADMIN_TOKEN` (set locally, never commit its value);
  `NURAE_SECRET_KEY` should be ≥ 32 chars.

## Open threads — pick up here

1. **`views.tsx` + `bot-view.tsx` V4 depth pass** — blocked by guard false positives. Owner-approved
   smallest fix: rename `needsToken` → `needsSetup`, reword the credentials readout (em-dash form),
   then apply the depth pass (StatusBar with real counts, Glass list wrappers, row hovers, kickers)
   and re-run the gate + admin captures.
2. **`/admin/*` inner-view captures** — stop at the token gate in a fresh environment; set an admin
   token to re-shoot the inner tables.
3. **Optional**: pin an explicit font fallback stack next to the Geist variables (serif fallback in
   headless captures is pre-existing, capture-browser-only).
4. **Owner actions outstanding**: rotate the OpenRouter key, Gmail app password, and the admin token
   (all burned in git history at `64525cd`); resolve the push 403 (fresh PAT from the repo-owner
   account or collaborator grant) and push `9a69cb8`.
5. **Free-model quality**: prompt hardening for tool-call narration (models narrate unexecuted
   actions; honest tool errors already recorded) — Task 26 note.
6. **Axodex**: repo is indexed (AGENTS.md/CLAUDE.md boilerplate). Its rule — impact analysis before
   editing code symbols — still applies to source changes.

## Quickstart

```powershell
cd NURAE
npm install
npm test
$env:PORT = '3000'; npm run dev     # customer site at / , operator console at /admin
```
