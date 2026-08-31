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
