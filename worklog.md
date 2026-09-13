# NURAE — Multi-Agent Work Log

---
Task ID: 0
Agent: main (Super Z)
Task: Inspect repository, initialize fullstack environment, plan NURAE V00.00.000-beta-01

Work Log:
- Inspected repo: empty scaffold (.env, .git, download/, skills/, upload/)
- Initialized fullstack env: Next.js 16 + TS 5 + Tailwind 4 + shadcn/ui + Prisma/SQLite + Bun (port 3000, Caddy gateway)
- Checked connectivity: api.telegram.org reachable; outbound HTTPS OK
- Loaded LLM skill: z-ai-web-dev-sdk chat.completions.create() for built-in GLM provider

Stage Summary:
- Plan: shared version module → Prisma schema → core libs (secrets/sanitize/validation) → AI provider layer → runtime mini-service (port 3030) → Next.js API → dashboard SPA at / → .env.example + README → bun tests → verification
- Key decisions: runtime isolated in mini-services/nurae-runtime; shared SQLite with WAL; tokens encrypted at rest (AES-256-GCM); auth via NURAE_ADMIN_TOKEN (optional); only / page (SPA), all else under /api/*

---
Task ID: 1
Agent: main (Super Z)
Task: Implement NURAE V00.00.000-beta-01 — AI-powered Telegram bot creation and operation

Work Log:
- Version source: src/lib/nurae/version.ts (NURAE_VERSION + FRAZIYM format parser, banner, identity line)
- Schema: prisma/schema.prisma — Project/Bot/Conversation/Message/Log, cascade deletes, WAL mode + busy_timeout for two-process SQLite
- Secrets: SecretManager AES-256-GCM at rest (env key or auto-generated db/.nurae-secret-key); log sanitizer redacts token/key patterns at write AND read
- AI layer: AIProvider interface + registry; zai built-in (zero-config GLM) + OpenAICompatibleProvider covering openai/openrouter/deepseek/glm/local/custom; timeouts, error classification, bounded retries with backoff + Retry-After, validateCredentials via /models probe with chat fallback
- Telegram: dependency-free adapter (getMe/deleteWebhook/getUpdates long-poll/sendMessage), error mapping (401/409/429/5xx)
- Runtime: BotRuntime (poll loop, /start /help routing, memory window, AI pipeline, friendly AI-failure messages, error states), BotManager (multi-bot, isolation, stopAll), isolated mini-service on :3030 with internal bearer token, startup banner, graceful SIGINT/SIGTERM shutdown
- API: projects CRUD, bots CRUD, config PUT, start/stop/restart proxy, status merge, sanitized logs, verify (Telegram + provider), stats, catalog, /health + /api/health; zod validation everywhere (422); admin token auth (cookie or bearer) on ALL admin endpoints
- Dashboard SPA at /: auth gate, overview stats, projects, project detail, bot detail (status/controls/config/logs with level filters + 4s auto-refresh), responsive, sticky footer, version everywhere
- Docs: README.md (17 sections, IMPLEMENTED vs PLANNED), .env.example
- Tests: 76 bun tests across 7 files — versioning, secrets, sanitizer, providers (mocked HTTP incl. timeout/retry/429), telegram adapter + runtime pipeline (mocked adapters), bot manager lifecycle/isolation, API routes against isolated temp DB, security (secrets never leak, 401s, 422s)
- Fixed bugs found by tests: stale lastError in provider retry loop; missing auth guards on lifecycle/bot routes; PRAGMA via $queryRawUnsafe
- E2E verified with Agent Browser: create project → create bot → start (real Telegram 401 → error state with clear alert) → logs → config edit → stats; mobile layout verified; built-in GLM provider produced a real AI reply

Stage Summary:
- NURAE V00.00.000-beta-01 COMPLETE: full DoD loop implemented and verified (dashboard → project → bot → start → status → logs → config → restart)
- 76/76 tests pass, lint clean, dev server + runtime service healthy
- Key artifacts: src/lib/nurae/* (shared core), mini-services/nurae-runtime (isolated process), src/app/api/* (REST), src/components/nurae/* (SPA), tests/nurae/* (bun test)
- Security posture: secrets encrypted at rest and never returned/logged; admin auth optional via NURAE_ADMIN_TOKEN; runtime protected by internal token; logs sanitized twice

---
Task ID: 2
Agent: main (Super Z)
Task: Push NURAE repository to github.com/akikfaraji/NURAE.git using user-provided PAT

Work Log:
- Verified working tree clean and all NURAE files committed on main (incl. src/app/api/auth/{login,logout,status}/route.ts)
- Probed remote with git ls-remote: repo existed but was empty (no refs)
- Added origin remote with PAT-authenticated HTTPS URL (akikfaraji:TOKEN@github.com/akikfaraji/NURAE.git)
- Pushed main -> origin/main with upstream tracking (new branch created)

Stage Summary:
- Push successful: commit 0977f47 (NURAE V00.00.000-beta-01) now HEAD of origin/main
- Verified on remote: src/app/api/auth/*, src/lib/nurae/*, mini-services/nurae-runtime/* all present
- Note: PAT is embedded in .git/config remote URL (user-provided token for this purpose)

---
Task ID: 3
Agent: main (Super Z)
Task: NURAE V00.01.000-beta-02 — STEP 1 audit + STEP 2 architecture design (webhook-first, Vercel-compatible refactor)

Work Log:
- Audited all core modules: version.ts, schema.prisma, secrets.ts, sanitize.ts, validation.ts, logging.ts, ai/* (types, registry, providers), telegram/adapter.ts, runtime/{store,bot-runtime,bot-manager}.ts, api/{base,lifecycle,runtime-client}.ts, all API routes, dashboard components (views/bot-view/bot-form/console/bits), tests (7 files, 76 tests), mini-services/nurae-runtime/index.ts, .zscripts, .env.example

Stage Summary:
- AUDIT VERDICT: architecture is solid overall (clean provider abstraction, centralized Telegram adapter, AES-256-GCM secrets, sanitized logs, zod validation, timing-safe admin auth). REUSE: schema (has all Step 6 fields), AI layer (Step 3 satisfied), store boundary, sanitizer, validation, auth guard, dashboard (Step 7 ~95% present)
- MAJOR CHANGE REQUIRED (explained per spec Step 1): three-process polling design (Next.js + :3030 runtime mini-service + SQLite WAL) is fundamentally incompatible with Vercel/serverless: (1) no second process/port allowed; (2) long-poll loops die with the invocation; (3) ephemeral filesystem wipes SQLite; (4) in-memory BotManager state lost. Per user directive "Plus vercel compatible refactor", the runtime merges INTO the Next.js app and webhook mode becomes the primary transport
- DESIGN DECISIONS (Step 5): transport = WEBHOOK primary (stateless, per-message invocation, Telegram redelivery semantics, works on Vercel; local polling kept as fallback for dev without public URL via NURAE_BOT_TRANSPORT=polling). Storage = Prisma libsql provider (file: local dev, libsql:// Turso on Vercel — one schema, both worlds). Secret key = env-first (NURAE_SECRET_KEY), key-file only as local fallback. State machine (Step 8) enforced in DB transitions. Shared transport-agnostic pipeline (Step 2 flow diagram) used by BOTH transports. Webhook secured via per-bot secret_token (X-Telegram-Bot-Api-Secret-Token, constant-time compare)
- Plan: version bump -> schema (libsql + Log.event + Bot.webhookSecretRef/transport) -> de-risk libsql db push -> state-machine.ts -> pipeline.ts extraction -> adapter webhook methods -> transport.ts -> lifecycle rework (delete runtime-client + mini-service) -> /api/telegram/webhook/[botId] -> status/DTO updates -> dashboard copy -> tests -> mock-Telegram E2E with real GLM -> README/.env.example -> commit (NO push)

---
Task ID: 3 (implementation)
Agent: main (Super Z)
Task: Implement NURAE V00.01.000-beta-02 — minimal working Telegram bot platform + Vercel-compatible refactor

Work Log:
- Version: src/lib/nurae/version.ts → V00.01.000-beta-02 (FRAZIYM convention preserved)
- Storage: Prisma libsql driver adapter (@prisma/adapter-libsql + @libsql/client); db.ts single code path — file: local / libsql:// Turso remote; schema provider stays sqlite (libSQL dialect); de-risked with sanity test (raw PRAGMAs OK)
- Schema: + Bot.transport, Bot.webhookSecretRef (encrypted), Log.event (structured codes)
- State machine (Step 8): runtime/state-machine.ts — 5 states, transition matrix enforced atomically in DB (updateMany where status in [...from])
- Pipeline (Step 2/4): runtime/pipeline.ts — transport-agnostic handleBotMessage (commands → memory → Provider Selector → AIProvider → reply) with Step-9 event codes on every log
- Telegram adapter: + setWebhook/getWebhookInfo; adapter unchanged otherwise
- Transport (Step 5): runtime/transport.ts — webhook primary (setWebhook+secret → RUNNING; deleteWebhook → STOPPED; getWebhookInfo status reconciliation incl. out-of-band webhook removal detection), polling fallback (in-process BotManager, refuses on serverless), webhook secret gen/verify (timing-safe), per-bot update dedupe (500-cap)
- Webhook route: /api/telegram/webhook/[id] — secret-gated (401 before existence disclosure), 400 malformed, 500 transient (Telegram retries), maxDuration 60 + nodejs runtime
- REMOVED: mini-services/nurae-runtime (isolated process), runtime-client.ts (localhost proxy), WAL pragmas (single process now)
- Security (Step 12): login timing-safe compare (safeCompare), .env untracked + gitignored, webhook route no-existence-oracle, DTOs secret-free (verified by tests), sanitizer covers all new log paths
- Lifecycle/API: start/stop/restart direct through transport; status merges persisted + Telegram-side state (pending_update_count, last_error); project delete stops bots via transport
- Dashboard: transport badge + pending-updates indicator on bot view, transport row in overview meta, Core online/offline badge (replaces Runtime badge), version strings from version.ts
- Tests: 92 pass across 8 files — new: state-machine matrix, webhook receiver (10 cases incl. duplicate suppression), shared stateful Telegram stub; updated: api lifecycle (real webhook flow in-process), version bump
- E2E (Step 14): scripts/e2e.ts + scripts/mock-telegram.ts — 13/13 PASS: health → create project/bot → start (webhook registered on mock) → /start welcome → REAL GLM reply via webhook pipeline (663-678ms) → memory follow-up → event-coded logs → @username/no-secrets → restart → stop (webhook removed) → invalid-token 401 path → cleanup. Real-Telegram delivery UNTESTED (no BotFather token in sandbox)
- Performance (Step 15): start→running 105-905ms (first-compile vs warm), webhook round-trip incl. GLM 663ms, next-server RSS ~652MB (dev mode), CPU idle ~0.2%. No scalability claims
- Docs (Step 16): README rewritten for beta-02 (webhook-vs-polling rationale, Vercel/Turso deploy guide §11, IMPLEMENTED/EXPERIMENTAL/PLANNED, limitations incl. per-instance dedupe + single-tenant ownership); .env.example full annotated rewrite
- Browser verification: dashboard golden path (create project → bot → start → RUNNING + webhook badge + live logs → delete) verified with agent-browser; mobile viewport + screenshots OK; no console errors

Stage Summary:
- V00.01.000-beta-02 COMPLETE: full Step-13 loop (login→create→configure→start→message→AI reply→stop→status→logs) implemented and verified at 3 levels: 92 unit/integration tests, 13-step E2E with real GLM, agent-browser UI pass
- Architecture now: single Next.js process, webhook-first transport, shared pipeline, DB-enforced state machine, libSQL/Turso storage — Vercel-deployable per README §11
- Honest gaps: real-Telegram delivery untested (no token), zai provider is sandbox-dependent (EXPERIMENTAL), dedupe per-instance, single-tenant auth model

---
Task ID: 4
Agent: main (Super Z)
Task: Split-deployment E2E — Actions backend x Vercel frontend, real services only (no mocks)

---
Task ID: 5
Agent: main (Super Z)
Task: Gateway Link — static frontend, moving backend (user-approved design: site-native storage, professional routes)

Work Log:
- Motivation: build-time NURAE_BACKEND_URL rewrite forced a frontend redeploy every run (ephemeral tunnel URLs). Gateway Link lets a frontend deployed ONCE find the backend at runtime
- Routes (frontend): POST /api/gateway/register (backend announces {endpoint,key}; timing-safe SHA-256 key compare, HTTPS-only, health check of <endpoint>/api/health must return NURAE V00-series before accept), GET /api/gateway/status (linked + host only), DELETE /api/gateway/register (key required)
- Store: Vercel Blob (gateway/backend-link.json, addRandomSuffix=false; no secrets stored) behind a swappable GatewayStore interface; 10s in-process read cache for the middleware hot path
- Middleware (src/middleware.ts): when NURAE_GATEWAY_KEY is set on the deployment, rewrites all /api/* except /api/gateway/* to the linked backend at REQUEST TIME (NextResponse.rewrite external URL) — replaces the build-time rewrite; 503 backend-not-linked until a link exists; pass-through (single-process mode) when key unset
- Backend: src/lib/nurae/runtime/gateway-link.ts — registers NURAE_PUBLIC_BASE_URL with the frontend on boot (src/instrumentation.ts register hook) and re-registers every 60s (tunnel origins are per-boot); structured log events GATEWAY_LINKED / GATEWAY_LINK_FAILED; also triggered from webhook bot-start path (idempotent)
- Version: V00.01.000-beta-02 -> beta-03 (new feature); version.test.ts + api.test.ts + e2e.ts assertions updated
- Workflow rework: frontend=gateway (default) uses the stable Vercel URL + backend self-registration — ALL Vercel CLI steps removed (pull/build/deploy were the fragile part); workflow polls /api/gateway/status until the tunnel host is linked; frontend=tunnel-only mode kept; secrets now TELEGRAM_BOT_TOKEN, AI_API_KEY, GATEWAY_KEY (VERCEL_* no longer needed)
- e2e driver: E2E_GATEWAY_LINK=1 asserts /api/gateway/status reports THIS tunnel before the rest of the chain
- Docs: README 14.1 (Gateway Link) + 14.2 (workflow), .env.example gateway block
- Tests: 101/101 pass (9 files; new gateway.test.ts covers 401/422/502/501/timing-safety/success+unregister paths); build passes with middleware compiled

Stage Summary:
- beta-03: static frontend + self-registering backend; per-run Vercel rebuilds eliminated from CI
- One-time user setup for gateway mode: deploy once on Vercel + create Blob store + set NURAE_GATEWAY_KEY env + put GATEWAY_KEY in GitHub Secrets
- Gateway Link middleware proxy and Actions gateway E2E remain honestly UNTESTED until first run with the new setup

---
Task ID: 6
Agent: main (Super Z)
Task: Fix split-e2e run-3 failure — backend self-proxied its own /api/health (503 backend-not-linked)

Work Log:
- Triaged run 33397550269 (ce3ecb2): preflight/build/tunnel all green, "Start backend" failed — health gate saw 503 for 60s despite "Ready in 71ms" in backend.log; runs 33396139382 + 33397295386 had failed earlier at preflight (GATEWAY_KEY secret not yet created — user fixed it before run 3)
- Root cause: the backend process needs NURAE_GATEWAY_KEY to register, but src/middleware.ts activated gateway proxying wherever that var was set — including the backend itself, which has no Blob link store → every /api/* (health included) answered 503 backend-not-linked on the backend's own port
- Fix (src/middleware.ts): role guard — middleware passes through when NURAE_LINK_FRONTEND_URL is set (a registering backend is never a gateway frontend); health stays proxied on real frontends so the e2e "health via frontend → backend chain" check keeps proving the chain
- Fix (gateway-link.ts): link outcomes now mirrored to stdout ([gateway] GATEWAY_LINKED / GATEWAY_LINK_FAILED) — DB-only logging made backend.log blind and run 3 undiagnosable from artifacts
- Version bump V00.01.000-beta-03 -> V00.01.001-beta-03 (bugfix digit per FRAZIYM format); version/api/gateway test fixtures updated
- Real verification (local standalone boots): (a) backend-role env (LINK_FRONTEND_URL+GATEWAY_KEY, exact run-3 env) → /api/health 200 (was 503); log shows the heartbeat firing and the REAL frontend answering 501 gateway-not-configured; (b) frontend-role env (GATEWAY_KEY only) → /api/health + /api/bots 503 backend-not-linked, /api/gateway/status gatewayMode:true — middleware still active where it belongs
- Live evidence: https://nurae.vercel.app/api/gateway/status currently returns gatewayMode:false and the real register call returns 501 — the Vercel deployment has NOT been put in gateway mode yet

Stage Summary:
- 101/101 tests pass; standalone build green; both gateway roles proven by real boots (backend: health 200; frontend: proxying 503-unlinked)
- Remaining blocker is one-time Vercel setup by the user: set NURAE_GATEWAY_KEY (production) = GATEWAY_KEY secret value, connect a Blob store, redeploy — then re-run the workflow
- Committed locally only; push awaiting user instruction

---
Task ID: 7
Agent: main (Super Z)
Task: Local self-hosting pivot — all configs in .env, gitignore verified, SETUP.md finished, clone-ready repo (user: "Move all configs to a .env file... test it locally in my termux debian environment... make me a how to setup manual")

Work Log:
- Found Task was largely pre-committed in 8de40b0 (SETUP.md 320 lines, .env.example rewrite, README pointers); finished the remaining gaps instead of redoing
- Completed local .env: DATABASE_URL (absolute), generated NURAE_SECRET_KEY (openssl rand -hex 32) + NURAE_ADMIN_TOKEN (hex 24), HOSTNAME/PORT, NURAE_BOT_TRANSPORT=polling, provider fallback keys, gateway section commented out
- Gap fix: DATABASE_AUTH_TOKEN documented in .env.example §1 + SETUP.md §9 (read by src/lib/db.ts, needed only for libsql:// Turso)
- .gitignore verified: .env* + !.env.example + explicit .env; git check-ignore .env → matched; never staged
- BUG FOUND by verification: with a real .env present, bun test failed 26/102 (401 cascade) — @prisma/client re-loads project .env at PrismaClient construction (fill-in mode) and REFILLED deleted vars (NURAE_ADMIN_TOKEN) at import('../../src/lib/db'); diagnosed via 5 bisect probes (P4 = db import); root cause confirmed not middleware/base.ts/stub
- Fix (tests/nurae/helpers.ts): neutralize externally-injected env with EMPTY-STRING overrides instead of delete ('' survives Prisma's refill; every NURAE consumer treats '' as unset — adminToken/transport/gateway/fallbacks); documented rationale in-file
- BUG FOUND: src/app/layout.tsx hardcoded stale "V00.00.000-beta-01" in metadata, violating the version.ts-only rule → metadata now derives from NURAE_NAME/NURAE_VENDOR/NURAE_TAGLINE/NURAE_VERSION
- Version bump V00.01.002-beta-03 → V00.01.003-beta-03 (bugfix digit); synced version.test.ts (3), api.test.ts health assert, .env.example header, SETUP.md §4 example; gateway.test.ts stub fixtures left at 002 (any valid version passes)
- Verification: 102/102 tests pass; db:push green; fresh build green; killed stale next-server holding :3000 (pid 1081); .env-ONLY standalone boot proven — PORT=3210 from .env honored, /api/health 200 + correct version, /api/projects 401 without token and 200 {"projects":[]} with the .env token, dashboard 200; final boot on :3000 with metadata showing V00.01.003-beta-03; ports left clean
- Committed c6b2c00 and PUSHED (user is about to clone; push covers prior local-only commits 5410d02/2880151/f5f7b9d/8de40b0 too — origin/main == local main)

Stage Summary:
- Repo is clone-ready: SETUP.md (Termux Debian Part A + VPS Part B), .env.example complete incl. DATABASE_AUTH_TOKEN, .gitignore proven, all fixes on origin
- Test suite is now hermetic against a real populated .env (the exact state of a user clone following SETUP.md §2)
- Sandbox .env holds generated secrets for this machine only (gitignored); on Termux the user generates their own via SETUP.md §3
- Honest notes: real-Telegram delivery still unverified (no BotFather token here); Termux aarch64 path follows SETUP.md but was executed only in this x86 sandbox

---
Task ID: 8
Agent: main (Super Z)
Task: One-command setup — "make everything auto except the API tokens" (user hates complications)

Work Log:
- New setup.sh (repo root, executable): modes full (default) / dev / start / env
- Auto: Bun install if missing (curl|wget fallback), .env generation (bun node:crypto random secrets, ABSOLUTE DATABASE_URL=$PWD/db/nurae.db, HOSTNAME=0.0.0.0, PORT=3000, NURAE_BOT_TRANSPORT=polling), bun install, prisma db push, production build, server start
- Manual by design: only API tokens — optional AI fallback key prompt (TTY-only, fresh-.env-only, provider 1-6, Enter=skip); Telegram token explicitly NOT asked (per-bot, encrypted in DB, entered in dashboard) — final box spells out the 3 dashboard steps
- Safety: existing .env NEVER overwritten (secrets preserved; missing keys patched in); idempotency proven (md5 .env unchanged across reruns); Termux-native guard dies with "proot-distro login debian" hint; friendly ERR trap; pre-start health check → "already running" exit 0; LAN URL shown via hostname -I when available
- Bug caught in verification round 1: env mode fell through to build+start (linear flow) → restructured: env exits after prepare_db; also found stray next-server (pid 1095) from Task 7's final boot — earlier pkill -f 'standalone/server.js' missed the renamed next-server process; killed, port freed, cleanup pattern updated (pkill -f next-server)
- Docs: SETUP.md §2 rewritten as "Quick start (one command)" with modes + manual path in a <details> block; §7.1 VPS notes setup.sh works there too (then systemd); README §7 leads with the one-liner
- Version bump V00.01.003 → V00.01.004-beta-03; synced version.test.ts/api.test.ts/.env.example header/SETUP.md §4 example
- Verification: bash -n OK; 102/102 tests; fresh tar-copy simulation (no node_modules/.next/.env/db) → env mode generated correct .env (absolute path into the copy, 64-hex secrets, polling) without build/start; rerun kept .env byte-identical; main repo rebuilt at 004 → setup.sh start mode live boot: box printed, Next Ready in 83ms, /api/health 200 V00.01.004-beta-03; ports left free, temp artifacts removed
- Committed f2061b0, pushed; origin/main == local main; tree clean

Stage Summary:
- User's clone flow is now exactly: git clone → bash setup.sh → open printed URL → paste admin token → create bot with Telegram token + AI key
- Polling transport is the generated default: zero public URL/tunnel needed on Termux
- Honest notes: Termux aarch64 still untested on real hardware (script has the proot guard); webhook/§5.2 path unchanged for later server deployment

---
Task ID: 9
Agent: main (Super Z)
Task: "Let's make the setup.sh install all dependency to work. Nuclear" — fix exit 127 (prisma: command not found) on the user's real Termux Debian box (Bun 1.4.0, NO Node.js installed)

Work Log:
- Root cause chain (all empirically proven): (1) `bun run <script>` does not put node_modules/.bin on the script shell's PATH -> bare `prisma` = 127; (2) bunx is NOT the fix — it resolves the binary but honors the `#!/usr/bin/env node` shebang -> silent 127 on a node-less box (proven with a poisoned node stub on PATH); (3) DIRECT-BUN (`bun node_modules/prisma/build/index.js db push`) works node-less — but (4) full `next build` under poisoned PATH dies in Turbopack's PostCSS step: "node process exited before we could connect ... exit status 127" — Next 16's build HARD-REQUIRES a real Node child process for PostCSS. Conclusion: a pure-Bun toolchain is impossible; Node must be installed
- setup.sh: hardened ensure_node() -> Node.js 22.x via NodeSource apt (user's proot Debian runs as root, so SUDO stays empty), dnf/apk/brew alternatives, then a NEW distro-independent node_tarball_install() fallback (arch-detected x64/arm64/armv7l, pinned v22.14.0, .tar.gz + `tar -xzf` for universal gzip, installs to $HOME/.local/nurae-node, PATH exported for the run + idempotent ~/.bashrc append); node_major()/node_ok() guard >=20; every package-manager attempt fails soft (`|| true`) so the tarball is the guaranteed last resort; say messages explain node is build-tool only, app itself runs on Bun
- package.json: ALL tool scripts rewritten from bunx to explicit `node <direct entry path>` — dev/build -> node node_modules/next/dist/bin/next, db:* -> node node_modules/prisma/build/index.js, lint -> node node_modules/eslint/bin/eslint.js; start stays node-free (`bun .next/standalone/server.js`). This form is immune to bun's missing .bin PATH AND to shebang resolution; setup.sh now calls `bun run db:push` (single source of truth) after ensure_node() guarantees node
- tests/nurae/helpers.ts pushTestSchema(): bunx prisma -> node entry path (same immunity); README.md Turso recipe updated to the node entry form; zero bunx left in the repo
- Version bump V00.01.004 -> V00.01.005-beta-03; fixtures synced (version.test.ts, api.test.ts health assert, .env.example header, SETUP.md §4 health example); SETUP.md requirement table now says Node 20+ is a build tool installed automatically by setup.sh (~120 MB), app runs on Bun
- Verification: bash -n OK; ensure_node e2e test (persisted scripts/test-ensure-node.sh) — poisoned node + apt-get/dnf/apk/brew stubs exiting 1 + isolated HOME -> tarball fallback downloaded v22.14.0, "Node.js v22.14.0 ready", .bashrc persisted, tarball node --version works; run 2 with real node short-circuited ("Node.js 24 found"); bun run db:push OK; bun run build exit 0; standalone boot -> /api/health 200 V00.01.005-beta-03; 102/102 tests; stale-server cleanup (pkill -f next-server) after boot check; 200 MB test artifacts removed

Stage Summary:
- User's recovery is exactly: cd ~/nurae/NURAE && git pull && bash setup.sh — existing .env + 882 installed packages preserved; setup.sh installs Node 22 (their box lacks it — that was the whole bug), db push/build/start all proceed automatically
- Honest note: ensure_node's apt/NodeSource path is standard but UNTESTED on the user's real device; if it ever fails the tarball fallback is the safety net (proven in sandbox); Termux aarch64 build RAM remains the known constraint (dev mode documented for low-RAM phones)
- OpenRouter key rotation still outstanding (sk-or-v1-680e… family, pasted in chat + leaked at f5b1441)

---
Task ID: 10
Agent: main (Super Z)
Task: "do we really need bun? ... If we don't need bun use node npm or npx or pnpm or all as options" — make Node.js the only required runtime

Work Log:
- Evidence audit: src/ has ZERO bun imports (portable Next.js app); tests import 'bun:test' (9 files); next.config output=standalone is designed for node. Verdict: bun is NOT required — demoted to optional accelerator
- package.json: start = `node .next/standalone/server.js` (canonical standalone flow, was bun); added engines >=20.9; "test" stays `bun test tests/nurae` (dev-only, never in setup.sh — migrating to vitest would add ~40 MB dev deps to every install for zero deployment value)
- setup.sh: ensure_bun() DELETED (bun is never downloaded anymore); new pick_pm() — bun if present (fast path, user's box keeps it), else npm (ships with Node); ensure_node now runs FIRST (node = the required runtime); gen_hex via node -e; VERSION_LINE read via sed from version.ts (no runtime needed at all); install = bun install OR npm install --no-audit --no-fund; db:push/build/start/dev via "$PM" run
- npm trial (fresh copy of HEAD, isolated): npm install (exit 0; npm defers some postinstall scripts — harmless, db push regenerates the Prisma client) -> npm run db:push OK -> npm run build OK -> node server.js boot -> /api/health 200. Pure npm+node deployment path proven end-to-end
- CRITICAL BUG FOUND BY THE TRIAL: trial copy nested inside the repo dir -> Turbopack inferred /home/z/my-project (ancestor lockfile) as workspace root -> standalone output mislaid (server.js missing, .npm-trial dir embedded in output) AND the trial build WIPED main/.next (only dev/ survived). Fix: next.config.ts pins `turbopack: { root: __dirname }` — deterministic root, silences the multiple-lockfiles warning, protects any user who clones NURAE inside another JS project. Verified: main rebuild + trial rebuild both produce correct standalone layout, warning gone
- package-lock.json (564 KB) committed — reproducible npm installs (the guaranteed path); bun.lock stays for dev/test; both runners verified
- Docs pass: SETUP.md (requirements: Node 20+ required / Bun optional; Termux section: no bun install step; manual path, §4 commands, §7.1 VPS, §7.2 systemd ExecStart=/usr/bin/node + NODE_ENV=production, §7.5 update flow, §10 troubleshooting — all npm now); README (§6 requirements, §7 install, §9 db, §10 run, §14 testing "102 tests across 9 files", bun test noted as the test runner)
- Version V00.01.005 -> V00.01.006-beta-03; fixtures synced (version.test.ts x3, api.test.ts, .env.example, SETUP.md §4)
- Verification: bun run build exit 0; node boot -> health 200 V00.01.006-beta-03; 102/102 tests; trial dir + logs cleaned; stale next-server killed after boot checks

Stage Summary:
- NURAE now runs 100% on Node.js + npm; bun is optional (auto-used if present for install speed; runs the dev test suite). On the user's Termux box nothing changes operationally (bun present -> bun install; server now runs under node)
- Honest notes: pnpm deliberately NOT wired in (untested code path — npm+bun are both proven; trivial to add later); NodeSource apt path still UNTESTED on real hardware, tarball fallback remains the safety net; OpenRouter key rotation still outstanding

---
Task ID: 11
Agent: main (Super Z)
Task: User's re-run failed at db push with "Cannot find module node_modules/prisma/build/index.js" (node v20.19.2 got installed OK) + directive "remove bun entirely"

Work Log:
- Diagnosed the user's error: node installed fine (20.19.2, Debian apt path), the new node-entry script ran, but node_modules/prisma was MISSING on their box — a half-repaired node_modules (interrupted install / bun-vs-npm layout transition); bun install had exited 0 while trusting its lockfile instead of verifying the tree. Fix in setup.sh: after npm install, verify the two entry points (prisma/build/index.js, next/dist/bin/next); if missing -> warn + rm -rf node_modules + reinstall once; still broken -> die with the exact repair command
- Bun REMOVED ENTIRELY per user directive:
  - package.json: "test" = "vitest run" (vitest 4.1.11 devDep added); bun-types devDep deleted; tsx 4.23.13 devDep added (for e2e.ts/mock-telegram.ts under node); bun.lock deleted + gitignored
  - Tests: 9 files' imports 'bun:test' -> 'vitest' (all used only describe/expect/test/afterAll/afterEach — zero bun-specific APIs); vitest.config.ts added with '@' resolve alias (mirrors tsconfig paths — Vite does NOT read tsconfig paths; the earlier audit missed the alias because src/ route handlers import via '@', reached from tests through relative imports) and fileParallelism: false (shared SQLite test DB + pushTestSchema race)
  - Suite result: 114 tests / 9 files ALL PASS under vitest — 12 MORE than bun's 102 (the two alias-importing files now run their complete set under vitest)
  - setup.sh: pick_pm deleted; ensure_npm() only; install path single npm install; entry-point verification + auto-repair added
  - CI .github/workflows/split-e2e.yml: setup-bun step removed; npm ci --no-audit --no-fund; npm run db:generate/db:push/build; node .next/standalone/server.js; e2e driver via npx tsx
  - .zscripts platform scripts converted: dev.sh, build.sh, start.sh, database-runtime-build.sh, mini-services-install.sh (bun install/run/server -> npm/node); mini-services-build.sh bun build --target bun -> npx esbuild --bundle --platform=node (UNTESTED — dormant platform path); mini-services-start.sh bun file -> node file
  - tests/database-runtime-build.sh harness: fake bun stub -> fake npm stub (intercepts `npm run db:push` identically)
  - scripts/mock-telegram.ts: Bun.serve rewritten to node:http createServer + web-standard Request/Response globals (Node 22+); smoke-tested: getMe OK, /__dump records calls
  - Docs: SETUP.md + README purged of every bun mention (requirements, Termux notes, manual paths, testing section now "npm test — 114 tests across 9 files (vitest)")
- Version V00.01.006 -> V00.01.007-beta-03; fixtures synced (version.test.ts x3, api.test.ts, .env.example, SETUP.md)
- Verification: clean npm install from scratch (repair-path validation, exit 0, prisma+next+vitest+tsx present); npm test 114/114; mock-telegram node smoke; npm run build exit 0; node boot -> /api/health 200 V00.01.007-beta-03; whole-repo rg audit: ZERO functional bun references (only transitive "is-bun-module" eslint helper name + intentional migration-note comments)

Stage Summary:
- The repo is now 100% Node.js + npm: setup.sh installs Node (auto), npm installs deps, vitest runs tests, node serves the standalone build. No bun anywhere in toolchain, CI, platform scripts, tests, or docs
- The user's exact failure mode (missing prisma in node_modules) is now auto-repaired by setup.sh's entry-point check + one-shot reinstall
- Honest notes: user's box must run git pull then bash setup.sh — npm install will rebuild node_modules (takes a few minutes on the phone); mini-services esbuild path UNTESTED (dormant platform scaffolding); CI workflow npm conversion UNTESTED (needs a GitHub Actions run); OpenRouter key rotation STILL outstanding

---
Task ID: 12
Agent: main (Super Z)
Task: "remove zai from the built in ... use the openrouter free models instead" + "premium black" monochrome UI redesign

Work Log:
- ENVIRONMENT HAZARD DISCOVERED: a sandbox background process maintains a Task-11-era source snapshot at /tmp/my-project and periodically syncs it OVER /home/z/my-project — it reverted working-tree edits mid-flight AND slipped stale test-file content into commit c45e08e (shipped old ai-providers.test.ts). Recovery: git fetch showed origin/main intact (Tasks 10/11) -> git stash + reset --hard origin/main + stash pop; subsequent workflow = edit -> verify in-script -> commit -> push -> rsync the corrected state back over /tmp/my-project so future syncs are harmless (rsync -a --delete, excl node_modules/.next/.env/db/logs)
- zai provider removed: src/lib/nurae/ai/providers/zai.ts deleted, z-ai-web-dev-sdk dropped from package.json (+lockfile synced), PROVIDER_IDS now 6 entries, default provider openrouter, default model openrouter/free (validation.ts, bot-form.tsx)
- OpenRouter catalog entry: label "OpenRouter — free models included", defaultModel openrouter/free ("Free Models Router" — auto-picks among free models), starter list fetched LIVE from openrouter.ai/api/v1/models (pricing.prompt=='0', text modality, sorted by context): thinkingmachines/inkling:free (1M ctx), nvidia/nemotron-3-super-120b-a12b:free, google/gemma-4-31b-it:free, nex-agi/nex-n2.5-pro:free, inclusionai/ling-3.0-flash-vl:free, nvidia/nemotron-3-ultra-550b-a55b:free; description documents rotation + manual model ids
- Legacy shim: selectProvider('zai') -> openrouter (pre-existing bots keep starting; OPENROUTER_API_KEY env fallback covers the key); shim covered by a new test
- Premium black UI (dark-only): globals.css :root AND .dark = zero-chroma oklch palette (bg 0.09, card 0.12, white primary 0.97/black-on-white text, border 0.22, grayscale chart tokens, restrained error red 0.55/0.18/25, radius 0.5rem); html forced class="dark"; Toaster theme="dark" (richColors dropped); favicon = local public/icon.svg (black rounded square + white N path) replacing the z-cdn.chatglm.cn logo
- Color sweep: ALL emerald/amber/red/zinc light-theme utility classes neutralized to tokens across bits.tsx (status badges: running=solid white pulse, starting/stopping=dim pulse, stopped=gray, error=destructive-outline; status dots; stat accents dropped), console.tsx (logo tiles bg-foreground/text-background, health badge, core dot, submit), bot-view.tsx (log levels warn->muted/error->destructive, pending count, error text, remove button), bot-form.tsx (error box destructive-outline), views.tsx (7 emerald buttons -> default white primary, status dot, dividers, skeleton), plus zinc/white inventory-wide tokenization
- Tests: zai describe block + ZaiProvider import removed; catalog assertions updated (>=6 providers, no zai, openrouter defaultModel, legacy shim); api.test create fixture carries an explicit apiKey (route correctly 422s keyless openrouter bots when no env fallback — helpers neutralize env); catalog >= 6
- Version V00.01.007 -> V00.01.008-beta-03 (fixtures synced); README rewritten (provider layer, requirements: OpenRouter key recommended, §13 providers guide, EXPERIMENTAL free-tier rotation note, test count 113)
- Verification: 113/113 vitest; npm run build exit 0; node boot -> /api/health 200 V00.01.008-beta-03; LIVE BROWSER VERIFICATION via agent-browser: overview + projects + create-project + create-bot form screenshotted — deep black, monochrome N mark, white primary buttons, provider dropdown "OpenRouter — free models included", model default openrouter/free; commits c45e08e/ff36134/28951f8 pushed with git show content verification; /tmp/my-project snapshot re-synced after each push

Stage Summary:
- zai is gone; OpenRouter free models are the default path (one free key, openrouter/free auto-router default); legacy zai bots transparently map to openrouter
- UI is premium black: monochrome tokens everywhere, dark-only, local SVG favicon
- Honest notes: free-model catalog ROTATES (users can type any model id); the create-bot 422-on-missing-key now correctly demands a key for every provider except local — dashboard + tests aligned; sandbox snapshot-sync hazard documented (workaround: push fast + re-sync /tmp/my-project); OpenRouter key rotation STILL outstanding

---
Task ID: 13
Agent: main (Super Z)
Task: "make the official NURAE bot for telegram" + users UI + admin to /admin + root for normal users + Gmail verification (app password) + Google sign-in + admin login key akik16 + customer/site details in admin + DB saves keys and everything

Work Log:
- Route split: `/` is now the PUBLIC site (landing + customer sign-up/sign-in + NURAE CS Bot web chat); the admin console moved to `/admin` (page.tsx moved, console header re-branded "NURAE Admin" + View-site link). All admin APIs stay under /api/* behind NURAE_ADMIN_TOKEN.
- Prisma schema: new models User (scrypt passwordHash, googleId, emailVerified, role, lastLoginAt), Session (30-day token rows), VerificationToken (scrypt-HASHED 6-digit codes, 15-min TTL), SiteSetting (key/value). Bot.telegramTokenRef made NULLABLE (the official bot exists before the admin adds a token); runtime paths hardened: runtime/store.ts (null ref -> empty token, no throw), transport.ts startBot (clear "No Telegram bot token configured" error + transition to error), dropWebhookQuietly + getBotRuntimeStatus null-guards, verify route ("No Telegram token stored yet"), BotRowLike.telegramTokenRef: string|null. Schema default provider fixed zai/glm-4.5-flash -> openrouter/openrouter/free.
- Auth core (src/lib/nurae/auth/): passwords.ts (scrypt N=16384 r=8, maxmem default — NOTE: setting maxmem=128*N*r EXACTLY trips OpenSSL "memory limit exceeded"; leave Node's 32MB default), rate-limit.ts (fixed-window in-memory + proxy-aware clientKey), mailer.ts (nodemailer 7, smtp.gmail.com:465, dev-mode code fallback when NURAE_GMAIL_USER/APP_PASSWORD unset), sessions.ts (nurae_session HttpOnly cookie, 30d, UA recorded), google.ts (hand-rolled OAuth code flow — state CSRF cookie, token exchange, userinfo; no next-auth dep), settings.ts (site info defaults + officialBotPrompt builder), official-bot.ts (idempotent seeding via site_settings pointer official_bot_id; self-heals if the row is deleted; supportChatTurn reuses the pipeline's selectProvider with per-user chatId web:<userId>; 20 msg/min/user limiter; honest 503 bot_not_configured when no AI key anywhere).
- Public API: /api/auth/register|verify|user-login|user-logout|me, /api/auth/google/start|callback (501 when unset, ?auth_error= redirect on failure), /api/support/status|chat|history, /api/public/site-info (whitelisted settings + which auth methods are configured). Admin API: /api/settings (GET/PUT), /api/official-bot (lazy-seeds + status card data), /api/admin/customers (GET list w/ chat+session counts; DELETE cascades sessions/tokens/web-chat), /api/stats now includes users count.
- UI: new monochrome icon set (icons.tsx — 17 stroke-based currentColor SVGs); public site (site.tsx: hero + features + auth card with sign-in/sign-up/verify-code steps + Google button when configured + ?auth_error/?welcome param handling; support-chat.tsx: persisted chat UI with typing indicator + structured error notices). Admin: OfficialBotCard on overview (fill-in-the-keys status: AI key / Telegram token / runtime), CustomersView (table + delete confirm), SiteSettingsView (site name/tagline/support email/telegram handle/welcome message), Customers + Site nav items, 5-stat overview grid.
- Verification flow honesty: Gmail SMTP unset => register returns devCode (clearly labeled) so localhost stays usable; configured => code ONLY in the email. Codes stored scrypt-hashed; uniform login errors (no account enumeration); per-IP and per-account rate limits (register 10/10min, verify 20/10min IP + 8/10min account, login 10/10min).
- Tests: new tests/nurae/platform.test.ts (20 tests: seeding idempotency, hashed codes, full register->verify->login->logout flow, unverified 403, rate-limit 429, Google 501/302/CSRF-reject, support chat 401/403/503 + AI-stubbed reply with persisted web:<userId> memory, settings round-trip + public whitelist, customers list/delete cascade). Suite: 133/133 across 10 files (was 113/9).
- Version V00.01.008 -> V00.01.009-beta-03 (fixtures synced: version.ts, version.test.ts x3, api.test.ts, .env.example header, SETUP.md §4). Docs: README (§1 platform loop, §8 env table, §9 entities, §14 133 tests), SETUP.md (§3 new vars, new §6.1 official bot + customer accounts, §9 reference), .env.example (new §4b Gmail + Google + NURAE_PUBLIC_URL).
- Verification: vitest 133/133; tsc clean in src (only pre-existing gateway/store.ts + scaffold lint errors remain — carousel.tsx/use-mobile.ts pre-date this task); npm run build exit 0; standalone boot -> health V00.01.009-beta-03, / and /admin 200; LIVE BROWSER E2E: landing -> create account -> dev code -> verify -> chat view -> message sent -> honest "not configured yet" notice (no AI key on this box); admin: official card (Fill in the keys), Customers table (verified/unverified/sessions/chats), Site settings form. Boot-seeded NURAE Official project + NURAE CS Bot (openrouter/free) confirmed in DB. Test accounts cleaned from dev DB.

Stage Summary:
- NURAE is now a two-faced platform: localhost:3000 = customer site (sign up with Gmail verification or Google, chat with the official NURAE CS bot), localhost:3000/admin = operator console (bots, customers, site settings). The official bot is pre-seeded — the operator fills in the keys and runs it; the same row powers the web chat (AI key only) and Telegram (token required).
- Honest notes: the admin key "akik16" the user requested is NOT committed anywhere in the repo (public repo — committed keys would be a real vulnerability); the user must set NURAE_ADMIN_TOKEN=akik16 in their local .env. Gmail/Google features are env-gated and hidden until configured; dev-mode verification codes appear ONLY while SMTP is unset. Rate limiting is single-process in-memory (fine for self-hosted scope). Google callback success path UNTESTED against real Google (no credentials in sandbox) — start/CSRF/501 paths are covered. OpenRouter key rotation STILL outstanding.

---
Task ID: 14
Agent: main (Super Z)
Task: fix user-reported bugs — (1) "failed to verify" on registration, (2) cannot configure API keys/system prompt for the official NURAE CS bot, (3) general breakage at the current stage; plus add the official CS system prompt

Work Log:
- Reproduced both flows against the live dev server BEFORE changing anything: register→dev-code→verify→me and the admin bot-config save (PUT 200 via UI dialog) both WORK on a clean V00.01.009 sandbox — the user's breakage is environmental/stale-state, so the fix package targets root causes + hardening rather than blind patching
- ROOT CAUSE #1 (setup.sh update path): `start` mode reused ANY existing build blindly, and a running old server made setup print "nothing to start" and exit — after `git pull` the user keeps talking to the stale V00.01.008 server (no /api/auth/verify, no official bot). Fixes: build_is_stale() (rebuild when any src/prisma/public/config file is newer than .next/standalone/server.js OR the version string is absent from the build); resolve_running_server() (compares /api/health version vs source version, pkills stale next-server processes, dies with exact manual command if the port cannot be freed)
- ROOT CAUSE #2 (silent SMTP failure): when Gmail SMTP is configured but the send fails (most likely: app password pasted WITH SPACES — Google displays it grouped), register returned ok and the UI claimed "code is on its way"; no email ever arrived → user had nothing to verify. Fixes: gmailConfig() strips ALL whitespace from NURAE_GMAIL_APP_PASSWORD; register returns mailError with an actionable mailFailureHint() (535/534/auth/network → concrete fix instructions, never leaks the password); verify step shows a destructive warning "The email could not be sent — no code will arrive" + a Resend-code button (register is idempotent for unverified accounts; notice tells users to use the NEWEST email since old codes are invalidated)
- Official bot configuration made unmissable: OfficialBotCard gained "Configure keys & prompt" (full BotForm dialog inline on the overview card — API key, Telegram token, prompt, model, sliders) plus "Reset prompt to official"; GET /api/official-bot now returns officialPrompt; POST /api/official-bot {action:'sync-prompt'} rebuilds the bot's prompt from current site settings
- Official CS system prompt (user request): officialBotPrompt() rewritten — persona, ABOUT NURAE, WHAT YOU HELP WITH (bots/providers/@BotFather/status codes/accounts/6-digit code expiry+spam+newest-email rule), HOW TO ANSWER (user's language, chat-friendly, no secret-fishing, honest escalation), support-email/telegram-handle escalation lines, greeting-style from welcomeMessage. Seed = 2334 chars, within systemPromptMax 8000
- Legacy zai rows: bots created pre-V00.01.008 still carry provider='zai' → catalog lookup undefined → API-key field didn't render → "cannot configure keys". migrateLegacyZaiBots() runs at boot (instrumentation): provider→openrouter, glm* models→openrouter/free, BOT_MIGRATED log row, idempotent. BotForm also hardened: unknown provider ids fall back to openrouter; off-catalog stored models stay selectable in the dropdown
- Console crash guard: BotView was rendered with catalog=null when catalog fetch failed (config dialog would crash on catalog.limits) — now a loading state until catalog exists
- Tests: +5 in platform.test.ts (prompt content/bounds/escalation, zai migration incl. log row + idempotency, gmailConfig whitespace, mailFailureHint mapping, officialPrompt in GET response). 138/138 across 10 files
- Version V00.01.009 → V00.01.010-beta-03 (version.ts, version.test.ts ×3, api.test.ts, .env.example, SETUP.md)
- Verification: tsc clean in src (only pre-existing gateway/store.ts + scaffold lint errors); npm run lint: 2 pre-existing errors only (carousel.tsx, use-mobile.ts); npm run build exit 0 with standalone output; stale-detection predicates verified against the fresh build; LIVE BROWSER E2E: admin login → new card (Configure keys & prompt / Open & start / Reset prompt to official) → inline dialog save (PUT 200, toast) → sync-prompt (DB prompt 2334 chars) → public site register → dev code → Resend → newest code → verify → chat with fake key returns honest "AI provider rejected the configured key" (expected for a fake key; proves the pipeline + structured errors); test users/chats cleaned from dev DB; tool-results/ accidentally committed then removed + gitignored (d724912)

Stage Summary:
- Commits 5a0516d + d724912 pushed (V00.01.010-beta-03); user recovery: `cd ~/nurae/NURAE && git pull && bash setup.sh` — setup now auto-rebuilds stale builds and replaces a stale running server; after restart the official bot card has direct "Configure keys & prompt"
- Honest notes: real Gmail delivery still UNTESTED end-to-end (no real app password in sandbox) — the mail-failure UI now names the exact cause if SMTP rejects; user's existing unverified account can simply register again or use Resend; OpenRouter key rotation STILL outstanding; user must re-enter their real OpenRouter key in the official bot card (the sandbox fake key was cleaned from the sandbox DB only)

---
Task ID: 15
Agent: main (Super Z)
Task: "AI output markdown shows raw (# and *) in Telegram" + "OTP mail never reached (log: connect ENETUNREACH 2404:…:465)" + user provided real Gmail credentials for diagnosis

Work Log:
- ROOT CAUSE (mail): nodemailer resolves smtp.gmail.com with its own resolver — c-ares dns.resolve4/resolve6 fail on Android/Termux (no readable /etc/resolv.conf), so it falls back to dns.lookup(all:true) and takes the FIRST address, which is the AAAA record → "connect ENETUNREACH 2404:6800:…:465" on networks without an IPv6 route. Fix: dns.setDefaultResultOrder('ipv4first') — process-wide in src/instrumentation.ts (runs at boot) AND defensively at mailer.ts module load; mailFailureHint gained an ENETUNREACH-specific actionable message
- LIVE SMTP PROOF: scripts/test-smtp.js (credentials from env only, never stored) — user-supplied fraziymtech@gmail.com app password DELIVERED successfully (250 2.0.0 OK, gmail accepted); DNS before/after shown in test output (AAAA first verbatim → A first after fix). Credentials themselves were VALID all along; only the IPv6 route was broken
- ROOT CAUSE (markdown): pipeline sent AI replies with no parse_mode (Telegram renders raw text). New src/lib/nurae/telegram/markdown.ts: dependency-free markdown → Telegram-HTML converter (# headings → <b>, **/__ → <b>, */_ → <i>, ~~ → <s>, `x` → <code>, ``` fences → <pre><code class=lang>, [t](url) + bare https URLs → <a> (safe schemes only), blockquotes → <blockquote>, bullets → •, table separator rows dropped, HR → ─ line); ALL text HTML-escaped before transforms (no entity injection possible), tags balanced by construction, unsafe schemes (javascript:) not linkified, snake_case protected
- Delivery hardening: chunkTelegramMessage splits >4000-char replies at paragraph/line boundaries (4096 hard limit guard); pipeline.sendMarkdownReply = convert → chunk → send with parse_mode HTML + link previews disabled; on Telegram 400 (entities rejected) automatically resends the raw chunk as plain text (TELEGRAM_HTML_FALLBACK log) — the reply ALWAYS arrives; system texts (/start, /help, failures) stay plain mode unchanged
- Tests: new tests/nurae/telegram-markdown.test.ts — 20 tests (converter, chunking incl. hard-slice, pipeline HTML send, 400 → plain fallback, /start stays plain). Tests caught 2 real bugs pre-push: bare-URL pass double-wrapped markdown-link hrefs (fixed: single combined link pass) + wrong fence expectation
- Version V00.01.010 → V00.01.011-beta-03 (5 sync points); SETUP.md §10: ENETUNREACH + never-arrives troubleshooting rows
- Verification: vitest 158/158 across 11 files (was 138/10); tsc clean in src (only pre-existing examples//scripts/e2e.ts scaffold errors); npm run build exit 0; standalone boot → /api/health V00.01.011-beta-03, / and /admin 200

Stage Summary:
- Commits pushed (V00.01.011-beta-03): OTP mail works on IPv6-less networks (user: git pull && bash setup.sh, then re-register); Telegram replies render markdown properly
- Honest notes: user's Gmail app password arrived via chat — advise rotating it after testing; sandbox delivery test = self-send to fraziymtech@gmail.com (check inbox/spam); end-user inbox arrival on the user's device is expected but not observable from the sandbox; OpenRouter key rotation STILL outstanding

---
Task ID: 16
Agent: main (Super Z)
Task: fix dev-server warning spam ("node:dns not supported in Edge Runtime" on every request + middleware→proxy deprecation) and create bug-reports.md alongside worklog.md (user request)

Work Log:
- BR-005 first attempt FAILED: /* turbopackIgnore: true */ on await import('node:dns') did NOT silence Turbopack 16.3.4's Edge-runtime static analysis (verified by booting dev + scanning log — warning persisted). Root fix instead: instrumentation.ts is compiled for BOTH runtime targets in dev, so ALL Node-only code was removed from it; the ipv4first DNS side effect stays solely in mailer.ts (Node-only auth-route bundle, module-scope → guaranteed to run before any sendMail). instrumentation.ts carries a NOTE comment so nobody reintroduces Node imports there
- BR-006: verified the proxy convention in the installed next 16.3.4 dist (PROXY_FILENAME, "must export a function named `proxy` or a default function") → git mv src/middleware.ts src/proxy.ts + export middleware()→proxy() + comment updates; only comment references elsewhere (gateway/store.ts), no test imports affected
- VERIFICATION: dev boot (next dev, Turbopack) → log scanned: zero Edge-Runtime/deprecation/"Ecmascript file had an error" lines, requests flow through proxy.ts; vitest 158/158 (11 files); tsc clean in src (pre-existing skills//examples//scripts/e2e.ts scaffold errors only); npm run build exit 0 (only a pre-existing tracing hint warning); standalone boot → /api/health V00.01.012-beta-03, / and /admin 200
- bug-reports.md created (user request): BR-001…BR-006 with symptom → root cause → fix → status/version mapping, notes on evidence, spam/newest-code guidance, credential-rotation reminders (no secrets, emails masked)
- Version V00.01.011 → V00.01.012-beta-03 (5 sync points)

Stage Summary:
- Dev log is clean; middleware officially migrated to the Next 16.3 proxy convention; bug-reports.md is now the user-facing bug history, worklog.md stays the technical log; both committed (no secrets)
- Honest notes: IPv4-first now applies only to the SMTP path (that is the only path that ever failed); the sandbox dev-boot warning scan is evidence, but the user should confirm their own console is clean after git pull; OpenRouter key rotation STILL outstanding

---
Task ID: 17
Agent: main (Super Z)
Task: user screenshot round — remove clickable ADMIN link from the customer site, fix "2 heads" (double header), fix web-chat markdown styling, add the missing user pages ("chat is only one of many pages"), add spam-folder guidance (Gmail tags NURAE mail as spam), rewrite outdated README

Work Log:
- Screenshot diagnosis (upload/Screenshot_20260913_193524_Chrome.jpg): confirmed 4 visual bugs — /admin link in public header; site header + chat-card header stacked ("2 heads"); assistant bubbles rendering RAW markdown (react-markdown was a dependency but never wired into the chat); single-page site with chat only
- Multi-page user site: new shared chrome src/components/nurae/site-shell.tsx (SiteHeader with Home/Chat/Help/About nav + active state + account area [email + Sign out], SiteFooter with Help/About links, useSiteUser hook, splash); routes /chat (dedicated full-height chat, signed-out guard card), /help (5-question FAQ incl. spam/newest-code answer + contact card fed by site settings), /about (about + live contact channels); site.tsx rewritten as SiteHome (hero + auth card logged-out; quick-links card logged-in; auth success now router.push('/chat')); ADMIN LINK REMOVED — owner reaches /admin by URL
- Double-head fix: Sign out + email moved into SiteHeader; chat card header reduced to a slim toolbar (small N tile + bot name + ONLINE dot) — one head per page
- Markdown fix (web): Bubble assistant path → react-markdown + remark-gfm (NEW dep) with new scoped .md-body styles in globals.css (monochrome headings/code/pre/links/lists/tables/blockquote; Tailwind v4 var() + color-mix — NOT hsl(var()), vars hold full oklch() values); user bubbles stay plain text; react-markdown refuses raw HTML in model output (XSS-safe)
- Spam guidance: verify step now ALWAYS shows a "Check the SPAM / Promotions folder — use the NEWEST email" tip above the code input (logged-in flow unaffected); /help FAQ answer; README §1; official CS prompt already covered it
- Browser E2E (agent-browser): / /chat /help /about all 200 + hydrate; nav renders; NO /admin link; full register → dev-code → verify → auto-redirect /chat flow PASSED; seeded a rich markdown assistant reply via scripts/seed-chat-markdown.js → structural DOM check: h3 ✓ strong×6 ✓ code×2 ✓ BotFather <a> ✓ GFM table 3 rows ✓ li×6 ✓ blockquote ✓ ZERO raw **/### visible; screenshot upload/after-markdown-fix.png; test user + conversation removed via scripts/remove-test-user.js
- README surgical update (was V00.01.000-beta-02/113 tests/"plain-text"): current release V00.01.013, customer flow = multi-page site, IMPLEMENTED += markdown-in-both-channels + customer accounts/site + official CS bot + transactional email/IPv4; §14 testing 158/11 files + markdown suite mention; limitations: plain-text-Telegram line removed (fixed in V00.01.011)
- Version V00.01.012 → V00.01.013-beta-03 (5 sync points); bug-reports.md BR-007…BR-011 added (BR-007 spam = MITIGATED — filter is on Gmail's side)
- Verification: vitest 158/158; npm run build exit 0 (30 static pages); dev boot: all pages 200, no warnings; tsc — NEW baseline note: pre-existing type strictness debt in tests/nurae/gateway.test.ts + api.test.ts(159) + src/lib/gateway/store.ts (vercel/blob typing) and scaffold files — visible now because earlier tsc outputs were truncated by head; runtime green (158/158), next build ignores tests; queued for a dedicated type-debt round
- remark-gfm added to package.json (+lockfile, additive only)

Stage Summary:
- The customer site is now a real multi-page product surface (Home/Chat/Help/About) with single-head chrome, zero admin exposure, markdown-rendered AI answers, and spam-folder guidance at the exact moment of need; README reflects the current stage
- Honest notes: BR-007 spam classification can only be mitigated in-product (guidance) — real remedies are Gmail-side (warm-up the sender, later: SPF/DKIM-aligned custom domain); chat E2E used the dev-code path (sandbox has no Gmail env); React components verified in-browser, not in vitest; OpenRouter key rotation STILL outstanding

---
Task ID: 18
Agent: main (Super Z)
Task: Take NURAE to the next level — product layer: chats, agents/tools, user-owned bots, files, Telegram expansion, featured, referrals; make it feel like NURAE, not a template (V00.02.000-beta-03)

Work Log:
- Recon first (per user instruction): read schema, pipeline, transport, adapter, sessions, official-bot, all UI components, README; identified the structural gaps: bots had NO user ownership (single-tenant admin), one boxed chat, no agent/tool layer, Telegram limited to /start+/help, duplicate footer on /about, boxed SaaS look
- Schema evolution: Bot.ownerId + commands_json/replies_json + archived; new tables ChatSession, ChatEntry, AgentStep, UserFile, Referral, ReferralReward, Entitlement; db push + generate
- Files subsystem (src/lib/nurae/files.ts): dependency-free PDF extraction (zlib stream inflate + Tj/TJ operators, escaped-string decode), DOCX via hand-rolled ZIP reader (word/document.xml → w:t runs), text/CSV/JSON inline, images/binary stored + reported honestly; pickFileContext = ownership-checked head+tail slices with a hard cap
- Secure tool layer (src/lib/nurae/agents/tools.ts): 11 tools (bots_list, bot_get, bot_create_draft, bot_update, bot_set_commands, bot_set_replies, bot_add_knowledge, bot_publish, bot_unpublish, files_list, files_read); ToolContext identity from session ONLY (no user-id in tool args), ownership filtered at query level, read/write kinds, consequential actions require model confirm:true AND user's explicit approval this turn, zod validation, AgentStep audit + sanitized platform Log rows; zod-v4 JSON-schema descriptors exposed at GET /api/agents/tools (MCP-compatible discovery)
- Bot Builder agent (src/lib/nurae/agents/bot-builder.ts): bounded model⇄tools loop (≤3 rounds, ≤6 actions), provider-agnostic JSON envelope protocol {message, actions, done} (works on free models without native function calling), lenient parsing, persistent task state in ChatSession.state (draft bot id, pending approval), durable entries + activity feed
- Chat service (src/lib/nurae/chat/sessions.ts): multi-session CRUD with ownership, rate-limited turns, attachment resolution (foreign file ids silently dropped), bounded file context, chat→agent routing: model emits {"handoff":"bot-builder","task"} → agent session created with task + file refs BY REFERENCE, agent runs its first turn immediately, UI gets handoff + [Open in Agent]
- User bots (src/lib/nurae/bots/user-bots.ts): draft-friendly creation (token optional), capabilities editing, ownership-enforced CRUD + lifecycle wrappers, TEST CONSOLE running the REAL pipeline (handleBotMessage/handleBotCallback) against a capturing sender — including the bot's actual AI provider
- Telegram expansion: custom menu commands (setMyCommands on start — webhook AND polling), command/keyword/button/fallback reply rules, inline keyboards + callback queries (answerCallbackQuery, namespaced r: data, honest unknown-callback answers), multi-message mini-workflows (first message carries buttons), photo captions reach the AI (caption-only vision, documented), deep-link /start payloads logged; allowed_updates widened to message+callback_query
- Referral/entitlements (src/lib/nurae/referral.ts): lazy invite codes (10-char, no lookalikes), pending reward at signup (ref param on /api/auth/register), qualification at email verify (2 days 'premium' entitlement, extends while active), guards: self-referral, unknown code, duplicate invited user (unique index + service checks); hasEntitlement is the only gate, server-side
- API surface: /api/chats(+[id],+messages), /api/files, /api/agents/tools, /api/agents/sessions(+[id]/messages), /api/my/bots(+[id],+publish,+test), /api/referral; register/verify wired to referral
- UI redesign (the "feel like NURAE" round): new site-shell (48px hairline header, compact text nav, account dropdown with invite+sign-out, small N mark top-right, mobile sheet); /chats full-page environment (sidebar/drawer, typography-not-bubbles messages, markdown+GFM incl. tables, auto-grow composer Enter/Shift+Enter, attach chips, honest empty state); /chats/agents workbench (activity feed ✓/× sourced from AgentStep, Approve & publish control, Open bot link); /bots list + create (manual + Create with AI) + detail (config, structured command editor, reply/button/workflow editor with Label => r:cb|url syntax, REAL test console, publish/unpublish with AlertDialog, archive/delete); /featured small page with sessionStorage prefill into /chats; home rewritten (typographic hero, statement features, ref capture); /about duplicate footer removed; /help updated; removed superseded support-chat.tsx + chat-page.tsx; /chat redirects to /chats
- Fix react-hooks/set-state-in-effect errors across new + pre-existing components (async IIFE pattern, render-phase reset pattern); fix markdown.ts comma-expression warnings
- telegram-stub extended: scripted aiResponses queue + answerCallbackQuery/setMyCommands methods
- Tests: NEW tests/nurae/product.test.ts (30 tests: capabilities round-trip/corruption, tool descriptors/ownership/confirmation-gating/audit/validation, agent turn + envelope parsing + cross-user isolation, chat sessions CRUD/turns/handoff/foreign-attachments, file extraction text/PDF-plain/PDF-zlib/DOCX/binary/bounded-retrieval, user bots draft/token/test-console/fallback+help/deep-link/photo/callback, referrals full-flow/guards/extension); suite now 188/188 across 12 files
- Version bump V00.01.013 → V00.02.000-beta-03 (feature release) across all 5 sync points; README fully rewritten to the product model; SETUP.md/.env.example version synced
- Verification: vitest 188/188; tsc clean in src+tests (pre-existing examples/scripts exclusions only); eslint src clean; production build PASS (all routes); REAL browser verification (agent-browser): desktop 1440×900 + mobile 390×844 — home, sign-in (seeded verified user via scripts/seed-browser-user.ts, NO real mail sent), /chats empty state + markdown thread (bold/italic/code/list/table) + composer Enter-send + handoff card, [Open in Agent] → agent workbench (✓ Created bot, honest × on a bad tool arg, markdown reply), /bots list → bot detail (config editors, test console: keyword rule fired with URL button rendered, publish without token → honest inline error), account menu → invite dialog (live referral link), /about single contentinfo, /featured, /admin boots; cross-user ownership in the real browser: user B opening user A's bot URL → "does not exist"; mock AI (scripts/mock-ai.js) used for chat/agent flows, then unwired + test data removed via scripts/cleanup-browser-verify.ts (official bot reset to seed defaults)

Stage Summary:
- NURAE V00.02.000-beta-03: the product layer is real — chat is the interface, the Bot Builder agent performs work through an audited, ownership-checked tool layer, bots are user-owned with commands/buttons/workflows and a real-pipeline test console, files flow into chats and agents by reference, referrals grant server-side entitlements. Public identity + code pushed to GitHub on main.
- Honest limitations (documented in README §4/§15): one real agent; file knowledge is prompt-distilled (no vectors); photo = caption-only; reply-keyboards not yet SENT (callbacks fully work); duplicate-update suppression per instance; referral is per invited user id (no fingerprinting).
- Security posture: agents cannot pass user ids (shape has no field), every bot/file query filters on session-derived ownerId, publish/unpublish require human approval per turn, every tool call audited twice (AgentStep + Log).
