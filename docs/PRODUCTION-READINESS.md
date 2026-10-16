# NURAE — Production Readiness Report

**Revision audited:** `9cbe81b` + the fixes applied in this session (V00.12.000-beta-01).
**Target:** make NURAE *working*, *secure* and *debuggable* in a real production deployment.
**Date:** 2026-10-16 · Windows 11 · Node v24.2x · Next.js 16.3.4.

**How this was produced:** four parallel audits, then an implementation pass, then an independent
verification pass by the lead agent — every number below was produced by running something, not by
reasoning. Items that could not be verified are labelled. One earlier conclusion of mine is
**corrected in §1.4**.

---

## Verdict at a glance

| Axis | Before | After this session |
| --- | --- | --- |
| **Working in production** | builds + serves; fresh install logs a Prisma error; readiness advertised before serving | boot error **fixed & verified**; `/api/ready` tells the truth; **new measured blocker: ≈82 s to real readiness on a cold install** |
| **Secure in production** | 8 findings, 1 Critical | **2 closed** (open loopback proxy; throttling/trust documentation); **Critical credential exposure still open — action required from you** |
| **Debuggable in production** | logger effectively unwired; static health; silent sink death | readiness + boot phase timings **landed & verified**; sink death now loud with a tmpdir fallback; hot-path wiring **still open** |
| **Verifiable at all** | 18 of 33 test files could not run on Windows | **34/34 files, 500/500 tests pass** |

---

## Part 1 — Working in production

### 1.1 Proven working (VERIFIED)

Production build + boot in a scratch copy, never touching your dev server on :3000:

| Item | Result |
| --- | --- |
| `npm run build` | exit 0, `✓ Compiled successfully in 2.2min` then `59s` on rebuild |
| `npm run start` → standalone | boots, honours `NURAE_DATA_DIR` + `PORT` |
| `/`, `/api/openapi.json`, `/api/health`, `/api/ready` | **200** |
| `/api/my/bots` unauthenticated | **401** with clean JSON (`Sign in first.`) — no 500, no HTML error page |
| Data resolution | DB + logs land in the data root, **not** the build output (chdir-immune) |
| `.env`, `db/`, uploads | correctly absent from the deploy artifact |

### 1.2 FIXED — fresh-install boot error (VERIFIED before → after)

`src/instrumentation-node.ts` installed the logger's DB sink **before** the schema existed, so every
fresh install wrote to a missing `logs` table and blacked out the DB sink for 60 s.

```
BEFORE (fresh data dir):  prisma:error … SQLITE_ERROR: no such table: main.logs
                          [NURAE] log DB sink unavailable for 60s: …
AFTER  (fresh data dir):  prisma:error occurrences      : 0
                          log DB sink unavailable       : 0
                          no such table: main.logs      : 0
                          [NURAE] schema sync: … in sync with your Prisma schema. Done in 532ms
```

The schema sync now runs first; `logging.ts` itself was not modified for this.

### 1.3 FIXED — deploy artifact hygiene (VERIFIED before → after)

The artifact used to contain the entire project (source, tests, docs, internal notes, npm logs), traced
in because of dynamic filesystem access in the logger. `scripts/postbuild.mjs` now prunes with an
allowlist instead of a name denylist:

| Artifact | Before | After |
| --- | --- | --- |
| Total | 3153 files / 195.7 MB | 2743 files / 185.5 MB |
| **Files outside `node_modules` + `.next`** | **428 / 10.39 MB** | **7 / 0.04 MB** |
| Leak probes (internal docs, logs, tests) | 31 present | **31 absent** |
| `npm_*_install*.log` | 6 | **0** |

Verified by listing the built artifact directly: `worklog.md`, `bug-reports.md`, `handoff.md`,
`integration.md`, `tests/`, `docs/`, `.github/`, `tsconfig.tsbuildinfo` and the npm logs are gone.

### 1.4 CORRECTED — readiness is honest now, and the boot stall is REAL

**My earlier conclusion in this report was wrong, and the evidence that corrected it came from the fix.**
I had measured "first HTTP 200 after 10.8 s" and downgraded the audit's 50–62 s stall to "unproven".
That 10.8 s was `/api/health` answering as a **static 200** while boot work was still running — I was
timing the very defect being reported. With honest readiness in place, the same measurement changes:

```
Fresh data dir, production build, /api/ready polled for a genuine 200:
  first /api/ready 200 after : 82.1 s   (20 attempts)
  payload: {"ready":true,"checks":{"bootComplete":true,"schemaSync":"synced",
            "dbReachable":true,"dataDirWritable":true},
            "phases":[{"phase":"process","durationMs":17652},…]}
```

So the boot stall is **confirmed and larger than the audit estimated on a cold install**. The new
`phases[]` payload begins to explain it: the `process` phase alone is **17.65 s** (module-graph load),
and the remaining ~64 s is now attributable phase-by-phase instead of being invisible.

**This is the top remaining "working" blocker:** a fresh deployment is not genuinely serving for ~80 s
while previously (and still, for `/api/health`) it looked healthy immediately. If you put a proxy or an
orchestrator in front of this, point its readiness probe at `/api/ready`, and consider raising timeouts
until the boot work is profiled and reduced.

`/api/health` keeps its original contract (`status/name/version/vendor/tagline/versionParsed/time`) and
now additionally reports `ready` + `readyReason`, so existing checks keep working.

### 1.5 FIXED — the test suite runs, and it is green (VERIFIED)

`tests/nurae/helpers.ts` hardcoded a Linux sandbox path (`cwd: '/home/z/my-project'`) for the test-DB
migration, so every DB-backed file died at import on Windows.

| | Test files | Tests |
| --- | --- | --- |
| Before | 19 failed / 14 passed (33 files) | 4 failed / 166 passed (170 collected) |
| **After** | **34 passed (34)** | **500 passed (500)** |

Changes: repo root resolved from the test file's own location (ESM `import.meta.url`), the temp
`DATABASE_URL` canonicalised to forward slashes, and the previously-fixed platform-correct expectations
in `tests/nurae/paths.test.ts` (11/11). Type check is unchanged from its pre-existing baseline of 61
errors (mostly `scripts/`, legacy test files and `src/lib/gateway/store.ts`) — **no new type errors**.
Note the suite grew from 33 to 34 files because a new readiness test file landed with the fix above.

---

## Part 2 — Secure in production

### 2.1 Verified sound (unchanged — do not regress)

Admin gate fails closed (503, not open) with timing-safe comparison; the admin cookie is a signed
HMAC blob rather than the raw token; session tokens are hashed at rest with `HttpOnly`/`SameSite=Lax`;
the agent tool layer takes identity from the session only, enforces ownership in-query, zod-validates
arguments and audits every call; consequential writes need model `confirm` **and** human approval;
secrets are AES-256-GCM with a fresh IV; the gateway key has no hardcoded fallback; the SSRF guard is
fail-closed with redirect re-guarding.

### 2.2 FIXED this session

| ID | Finding | Status |
| --- | --- | --- |
| S3 | `Caddyfile` shipped an unauthenticated loopback proxy (`:81` → `reverse_proxy localhost:{query.XTransformPort}`): anyone reaching port 81 could proxy to **any** loopback port | **FIXED** — rule deleted, why-comment added; the legitimate `localhost:3000` proxy retained |
| S6a | Rate limiting keyed unconditionally on client-supplied `X-Forwarded-For`, so the login throttle could be defeated by rotating the header | **FIXED** — the leftmost (edge-written) entry is trusted only when `NURAE_TRUSTED_PROXY=1`; default behaviour is unchanged and now documents its trust assumption. (This file also arrived with a syntax error from the implementation pass — a JSDoc block had lost its opening delimiter, producing 112 cascading type errors; I found and repaired it, and the type check is back to its 61-error baseline.) |

### 2.3 Still open — and the Critical one needs you

| ID | Severity | Finding | Why it is still open |
| --- | --- | --- | --- |
| **S1** | **Critical** | **The live `NURAE_ADMIN_TOKEN` value is committed in the tracked file `worklog.md`** (~lines 279, 294, 1048, 1070, 1113) | The redaction edit was blocked by the workspace write guard (it flags the file's secret-shaped lines) and the implementation run ran out of budget before working around it. **Treat this token as public: rotate it now.** Removing it from the file does not undo the exposure — rotation is the real fix, and it is yours to perform. |
| S2 | High | A plaintext gateway key literal is committed in `.github/workflows/split-e2e.yml`, and the workflow comments still instruct operators to reuse it as the production `NURAE_GATEWAY_KEY` (the app code is already fail-closed) | not reached |
| S4 | High | `bot_set_owner_chat` is `kind:'write'` and **not** consequential, so a prompt-injected agent turn can repoint a bot's order/payment alerts to an attacker's chat id | `src/lib/nurae/agents/tools.ts` write was blocked by the guard; the fix is one flag + description update |
| S5 | Medium | `NURAE_TELEGRAM_API_BASE` is honoured with no production gate while bot tokens travel in the URL | not reached |
| S6b/S6c | Medium | No minimum length enforced on `NURAE_ADMIN_TOKEN` (currently 8 chars); cookie `Secure` derived from a client-settable `x-forwarded-proto` | `src/lib/nurae/api/base.ts` and `sessions.ts` writes were blocked by the guard |
| S8 | Low | `.env` was committed in 9 historical commits, so the OpenRouter key, Gmail app password and admin token are effectively public; secret key is 27 chars | rotation only — see the runbook |

**Owner action required (I could not do this for you):**
1. Rotate `NURAE_ADMIN_TOKEN` to a long random value (≥32 chars) — the current one is exposed and weak.
2. Rotate the OpenRouter key and the Gmail app password (both are in git history).
3. Raise `NURAE_SECRET_KEY` to ≥32 chars (rotating it invalidates stored bot tokens/keys — re-save them).
4. Remove the committed gateway key from the workflow and set `GATEWAY_KEY` as a repository secret.

---

## Part 3 — Debuggable in production

### 3.1 Landed and verified

- **A truthful readiness endpoint** — `GET /api/ready` returns 200 only when boot is complete, the
  schema is settled, the DB answers a live query and the data directory is probe-writable; otherwise
  503 with the failing check named. Verified live (payload in §1.4).
- **Boot phase timings** — each boot phase now reports `durationMs`, so the startup interval is
  measurable instead of invisible. The first measurement already paid off: `process` = 17.65 s.
- **Honest health** — `/api/health` carries `ready`/`readyReason` alongside its original keys.
- **Sink death is no longer silent** — the logger used to disable a file sink permanently and say
  nothing anywhere. It now announces the degradation **once** on stderr, and on a read-only filesystem
  (e.g. a serverless deployment directory) it falls back to the OS temp directory rather than losing
  logging entirely.
- **Rotation counting corrected** — the JSONL rotation compared UTF-16 code units against a byte
  budget; with emoji/CJK content the "10 MB" threshold was under-counted substantially. It now counts
  real bytes.
- **A sink health surface** — `logger.health()` returns level, JSONL path + fallback state, DB sink
  degradation/queue depth and ring occupancy, so a readiness/diagnostic surface can report logging state.

### 3.2 Still open (the biggest remaining debuggability gap)

- **The structured logger is still largely unwired** — it has only two importers under `src/`, and its
  main production writer remains `internalError()` on 500s, while ~45 `console.*` sites and ~11 direct
  `db.log.create` sites bypass it. The live proof of the cost: the data-home `dev.log` contains a
  schema-sync failure that the structured JSONL, ring buffer and DB never saw.
- **Hot-path wiring not done:** webhook ingest + its rejections, transport lifecycle, AI provider
  failures, billing skips, agent turn / tool calls, scheduler tick, broadcast fan-out.
- **Request-id propagation** is still 500s-only; failed admin-auth attempts leave no trace.
- **Scheduler/broadcast honesty:** fan-out failures can still be turned into an empty list and marked
  as sent.
- **Admin tail** still reads the whole file synchronously on the request path.

---

## Part 4 — Housekeeping and status of the fix plan

| Plan step | Status |
| --- | --- |
| Phase 0 — make the suite run | **DONE** (34/34, 500/500) |
| 1a — boot ordering | **DONE + verified** |
| 1b — `/api/ready` + boot timings | **DONE + verified** |
| 1c — artifact hygiene | **DONE + verified** (allowlist; 428 → 7 non-dependency files) |
| 2a — credential redaction + runbook | **OPEN** (write guard + budget) — highest priority, and it needs your rotation |
| 2b — Caddyfile | **DONE**; CI gateway key **OPEN**; Telegram test-endpoint gate **OPEN** |
| 2c — consequential flag, admin-token minimum, cookie `Secure` | **OPEN** (writes blocked by the guard; one flag + two small edits) |
| Phase 3 — logger wiring / rotation / scheduler honesty | rotation + sink visibility **DONE**; wiring **OPEN** |
| Phase 4 — cleanup | **deliberately not done**: the 1.6 GB scratch copy `.audit/prod-runtime` is being kept as the evidence store for the verification above. Reclaim it any time with `Remove-Item -Recurse -Force .audit\prod-runtime` (plus `.audit\verify-data`, `.audit\verify2-data`). |

**Write-guard note:** several security fixes were refused by the workspace guard with
`artifact_secret_detected` on files that merely *mention* secret-shaped identifiers
(`tools.ts`, `api/base.ts`, `helpers.ts`, `worklog.md`). The children correctly did not try to bypass it.
Those edits need to be applied in a session where the guard permits them (or by you directly) — the exact
edits are small and are specified per finding above.

---

## Part 5 — Honestly unverified

- Single-machine, Windows only. No other OS, and nothing was executed on Vercel: the read-only-filesystem
  sink behaviour is proven in code and by the fallback logic, not observed on Vercel itself.
- Authenticated surfaces (admin routes, operator agent, real Telegram round-trip, live AI provider calls)
  were **not** exercised — no real `.env` was used anywhere in this work.
- Dependency CVEs were not checked against an advisory database.
- Git history was read, not rewritten; secret exposure in history is asserted from commit listing.
- The `≈82 s cold-start` figure is one measurement on one machine with a fresh data dir; treat the
  magnitude as indicative and the phase timings as the reliable instrument.
