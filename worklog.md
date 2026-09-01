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
