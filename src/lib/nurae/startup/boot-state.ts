/**
 * NURAE — boot phase timing + published readiness state.
 *
 * Two live defects this module exists for:
 *
 *  1. The startup interval was unlogged. The launcher printed
 *     "✓ Ready in 0ms" while the TCP port answered nothing for ~5 s
 *     (first real HTTP 200 measured at ~10.8 s on a fresh data dir) — with no
 *     per-phase timing anywhere, "why does the app take 11 s to answer" had no
 *     answer. recordPhase() now prints one line per boot phase with a
 *     durationMs (process start → dev.log → schema sync → super logger →
 *     official bot/fleet → gateway link → ticker) and keeps the same numbers
 *     in a machine-readable list.
 *
 *  2. There was no honest readiness signal. GET /api/health answered
 *     200 {"status":"ok"} while the boot migration was failing, and a probe
 *     that trusts it gates traffic to a server that cannot serve. This module
 *     is the ONE place the boot publishes what it actually achieved;
 *     /api/ready combines that with its own CHEAP live checks, /api/health
 *     reports it beside its liveness contract.
 *
 * Pinned on globalThis, like the Prisma client (src/lib/db.ts) and the logger
 * singleton (src/lib/nurae/logging.ts): Next.js can load instrumentation and
 * route handlers as SEPARATE module instances, so a module-local object would
 * be invisible to the readiness route.
 *
 * Readiness rule (decideReadiness) is a pure function — no I/O — so the rule
 * itself is unit-tested; the route only supplies live check results.
 */

/** One boot phase, in execution order. */
export type BootPhaseName =
  | 'process'
  | 'dev-logger'
  | 'schema-sync'
  | 'super-logger'
  | 'official-bot'
  | 'official-fleet'
  | 'gateway-link'
  | 'ticker';

export interface BootPhase {
  phase: BootPhaseName;
  /** Wall-clock cost of this phase; for `process` it is process.uptime(). */
  durationMs: number;
  at: string;
  ok: boolean;
  detail?: string;
}

/** Why a boot phase failed, when one did. */
export interface BootFailure {
  phase: BootPhaseName;
  message: string;
  at: string;
}

/** What the boot schema sync settled on (see startup/schema-sync.ts). */
export type SchemaSyncStatus =
  | 'synced'
  | 'skipped-opt-out'
  | 'skipped-managed'
  | 'skipped-missing-cli'
  | 'failed';

export interface SchemaSyncOutcome {
  ok: boolean;
  status: SchemaSyncStatus;
  detail: string;
}

export interface BootState {
  pid: number;
  startedAt: string;
  /** ms from process start to the moment boot recording began. */
  startedUpTimeMs: number;
  phases: BootPhase[];
  /** null until the schema phase ran. */
  schemaSync: SchemaSyncOutcome | null;
  bootComplete: boolean;
  bootFailure: BootFailure | null;
  /** Process start → boot complete (null while boot is still running). */
  totalMs: number | null;
}

const globalForBoot = globalThis as unknown as { __nuraeBootState?: BootState };

/** ms since process start — the only honest "process start" anchor. */
export function processUpTimeMs(): number {
  return Math.round(process.uptime() * 1000);
}

/**
 * Begin (or restart) the boot record for THIS process. Called once from
 * instrumentation; a second call resets the record instead of appending to it.
 */
export function beginBoot(): BootState {
  const state: BootState = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    startedUpTimeMs: processUpTimeMs(),
    phases: [],
    schemaSync: null,
    bootComplete: false,
    bootFailure: null,
    totalMs: null,
  };
  globalForBoot.__nuraeBootState = state;
  return state;
}

/**
 * The published boot record — what /api/ready and /api/health read.
 * null means instrumentation has not booted in this process (yet): readiness
 * must then report "boot-incomplete", never "ready".
 */
export function readBootState(): BootState | null {
  return globalForBoot.__nuraeBootState ?? null;
}

/**
 * Record one boot phase and announce it on stdout:
 *   [NURAE] boot phase schema-sync: durationMs=612 · synced · …
 * (stdout is what scripts/start-prod.mjs tees into server.log, so the startup
 * interval stays measurable after the fact.)
 */
export function recordPhase(
  phase: BootPhaseName,
  durationMs: number,
  opts: { ok?: boolean; detail?: string } = {},
): BootPhase {
  const state = globalForBoot.__nuraeBootState ?? beginBoot();
  const entry: BootPhase = {
    phase,
    durationMs: Math.max(0, Math.round(durationMs)),
    at: new Date().toISOString(),
    ok: opts.ok ?? true,
    ...(opts.detail ? { detail: opts.detail } : {}),
  };
  state.phases.push(entry);
  console.log(
    `[NURAE] boot phase ${phase}: durationMs=${entry.durationMs}${entry.ok ? '' : ' FAILED'}` +
      `${entry.detail ? ` · ${entry.detail}` : ''}`,
  );
  return entry;
}

export function markSchemaSync(outcome: SchemaSyncOutcome): void {
  const state = globalForBoot.__nuraeBootState ?? beginBoot();
  state.schemaSync = outcome;
}

/** Boot finished: every phase the server needs to serve traffic has run. */
export function markBootComplete(): void {
  const state = globalForBoot.__nuraeBootState ?? beginBoot();
  state.bootComplete = true;
  state.totalMs = processUpTimeMs();
  console.log(`[NURAE] boot complete: durationMs=${state.totalMs} · phases=${state.phases.length}`);
}

/**
 * Boot aborted: remember WHICH phase failed and why, so readiness can name it
 * instead of answering a cheerful "ok". The caller still rethrows — swallowing
 * a boot failure would leave a half-started server that reports healthy.
 */
export function markBootFailure(phase: BootPhaseName, err: unknown, durationMs = 0): BootFailure {
  const state = globalForBoot.__nuraeBootState ?? beginBoot();
  const message = err instanceof Error ? err.message : String(err);
  const failure: BootFailure = { phase, message, at: new Date().toISOString() };
  state.bootFailure = failure;
  recordPhase(phase, durationMs, { ok: false, detail: message });
  return failure;
}

export interface ReadinessInput {
  bootState: BootState | null;
  /**
   * Live checks. Omit a field when the caller does not perform that check
   * (e.g. /api/health is liveness-only and must stay I/O-free) — an omitted
   * check is not a passed check, it is simply not part of the verdict.
   */
  dbReachable?: boolean;
  dbDetail?: string;
  dataDirWritable?: boolean;
  dataDirDetail?: string;
}

export interface ReadinessResult {
  ready: boolean;
  /** Machine name of the FIRST failed check, null when ready. */
  reason: string | null;
  /** Human detail for that failure, null when ready. */
  detail: string | null;
}

/**
 * The readiness rule — PURE (no I/O, no caching), so the route can run it on
 * every request and a previously-green verdict can never be recycled:
 *
 *   1. boot published a state          → boot-incomplete
 *   2. boot did not fail               → boot-failed
 *   3. boot finished                   → boot-incomplete
 *   4. schema settled                  → schema-sync-failed / -unavailable
 *   5. DB reachable (live)             → db-unreachable
 *   6. data dir writable (live)        → data-dir-not-writable
 *
 * Steps 1–4 are boot facts (schema sync is work done once, not a per-request
 * check); 5–6 are live and must be re-run by the caller every time.
 */
export function decideReadiness(input: ReadinessInput): ReadinessResult {
  const state = input.bootState;
  if (!state) {
    return {
      ready: false,
      reason: 'boot-incomplete',
      detail: 'instrumentation boot has not started in this process',
    };
  }
  if (state.bootFailure) {
    return {
      ready: false,
      reason: 'boot-failed',
      detail: `${state.bootFailure.phase}: ${state.bootFailure.message}`,
    };
  }
  if (!state.bootComplete) {
    return { ready: false, reason: 'boot-incomplete', detail: 'boot sequence still running' };
  }
  const sync = state.schemaSync;
  if (!sync) {
    return { ready: false, reason: 'boot-incomplete', detail: 'schema sync phase never ran' };
  }
  if (sync.status === 'failed') {
    return { ready: false, reason: 'schema-sync-failed', detail: sync.detail };
  }
  if (sync.status === 'skipped-missing-cli') {
    // A file: database whose schema could not be settled: any route touching a
    // new column/table will 500 (this is the BR-031 live failure).
    return { ready: false, reason: 'schema-sync-unavailable', detail: sync.detail };
  }
  // 'synced' (boot pushed/verified the schema), 'skipped-opt-out'
  // (NURAE_AUTO_MIGRATE=0 — the operator took the schema over) and
  // 'skipped-managed' (libsql://… — real migrations are the operator's job,
  // the boot sync must stay out): all three mean the boot has SETTLED the
  // schema question, which is what readiness asks.
  if (input.dbReachable === false) {
    return { ready: false, reason: 'db-unreachable', detail: input.dbDetail ?? 'cheap read failed' };
  }
  if (input.dataDirWritable === false) {
    return {
      ready: false,
      reason: 'data-dir-not-writable',
      detail: input.dataDirDetail ?? 'probe write failed',
    };
  }
  return { ready: true, reason: null, detail: null };
}
