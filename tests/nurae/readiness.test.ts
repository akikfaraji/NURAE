/**
 * NURAE — boot truthfulness tests: phase timing + readiness.
 *
 * Covers the two defects the readiness work fixes:
 *  1. the startup interval was unlogged (no durationMs anywhere) → boot-state
 *     publishes one phase entry per boot step and prints durationMs;
 *  2. /api/health answered {"status":"ok"} during a FAILING boot migration, and
 *     nothing could gate traffic honestly → /api/ready answers 200 only when
 *     the boot facts AND the live checks pass, 503 (naming the failed check)
 *     otherwise, re-evaluating on every request (no cached "true").
 *
 * Hermetic on purpose: '@/lib/db' is mocked, so this file needs no database and
 * no test helpers — it runs standalone under `vitest run tests/nurae/readiness.test.ts`.
 */

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { BootState } from '../../src/lib/nurae/startup/boot-state';

const { queryRawUnsafe } = vi.hoisted(() => ({
  queryRawUnsafe: vi.fn<(sql: string) => Promise<unknown>>(),
}));

// The ready route's cheap liveness read — mocked so a DB that dies AFTER an
// earlier green verdict can be simulated exactly.
vi.mock('@/lib/db', () => ({ db: { $queryRawUnsafe: queryRawUnsafe } }));

const bootState = await import('../../src/lib/nurae/startup/boot-state');
const readyRoute = await import('../../src/app/api/ready/route');
const healthRoute = await import('../../src/app/api/health/route');

// --- fixtures + cleanup ------------------------------------------------------

const scratchDirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'nurae-ready-test-'));
  scratchDirs.push(dir);
  return dir;
};

const globalForBoot = globalThis as unknown as { __nuraeBootState?: BootState };
const clearBootState = (): void => {
  delete globalForBoot.__nuraeBootState;
};

/** Boot state as a finished, healthy boot would publish it. */
const completeBoot = (overrides: Partial<BootState> = {}): BootState => ({
  pid: process.pid,
  startedAt: new Date().toISOString(),
  startedUpTimeMs: 9,
  phases: [],
  schemaSync: { ok: true, status: 'synced', detail: 'The database is now in sync' },
  bootComplete: true,
  bootFailure: null,
  totalMs: 1234,
  ...overrides,
});

let logged: string[] = [];
let logSpy: ReturnType<typeof vi.spyOn> | null = null;
let prevDataDir: string | undefined;

beforeEach(() => {
  clearBootState();
  prevDataDir = process.env.NURAE_DATA_DIR;
  queryRawUnsafe.mockReset();
  queryRawUnsafe.mockResolvedValue([{ 1: 1 }]);
  logged = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  logSpy?.mockRestore();
  logSpy = null;
  clearBootState();
  if (prevDataDir === undefined) delete process.env.NURAE_DATA_DIR;
  else process.env.NURAE_DATA_DIR = prevDataDir;
});

afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

// --- the readiness rule (pure) ----------------------------------------------

describe('decideReadiness — the one readiness rule', () => {
  test('no boot state → boot-incomplete (never a fake ready)', () => {
    expect(bootState.decideReadiness({ bootState: null, dbReachable: true, dataDirWritable: true })).toEqual({
      ready: false,
      reason: 'boot-incomplete',
      detail: 'instrumentation boot has not started in this process',
    });
  });

  test('a failed boot phase → boot-failed, naming the phase', () => {
    const state = completeBoot({
      bootComplete: false,
      bootFailure: { phase: 'schema-sync', message: 'boom', at: new Date().toISOString() },
    });
    const verdict = bootState.decideReadiness({ bootState: state });
    expect(verdict.ready).toBe(false);
    expect(verdict.reason).toBe('boot-failed');
    expect(verdict.detail).toContain('schema-sync');
  });

  test('boot still running → boot-incomplete', () => {
    const verdict = bootState.decideReadiness({ bootState: completeBoot({ bootComplete: false, totalMs: null }) });
    expect(verdict).toMatchObject({ ready: false, reason: 'boot-incomplete' });
  });

  test('failed schema push → schema-sync-failed', () => {
    const state = completeBoot({ schemaSync: { ok: false, status: 'failed', detail: 'CLI exited 1' } });
    expect(bootState.decideReadiness({ bootState: state })).toMatchObject({ ready: false, reason: 'schema-sync-failed', detail: 'CLI exited 1' });
  });

  test('file: database with no prisma CLI/schema → schema-sync-unavailable', () => {
    const state = completeBoot({ schemaSync: { ok: false, status: 'skipped-missing-cli', detail: 'not found' } });
    expect(bootState.decideReadiness({ bootState: state })).toMatchObject({ ready: false, reason: 'schema-sync-unavailable' });
  });

  test('schema settled elsewhere (opt-out) still needs the live checks', () => {
    const state = completeBoot({ schemaSync: { ok: false, status: 'skipped-opt-out', detail: 'NURAE_AUTO_MIGRATE=0' } });
    expect(bootState.decideReadiness({ bootState: state })).toMatchObject({ ready: true, reason: null });
    expect(bootState.decideReadiness({ bootState: state, dbReachable: false, dbDetail: 'no such table' })).toMatchObject({
      ready: false,
      reason: 'db-unreachable',
      detail: 'no such table',
    });
  });

  test('live failures name their check: db then data dir', () => {
    const state = completeBoot();
    expect(bootState.decideReadiness({ bootState: state, dbReachable: false, dataDirWritable: false })).toMatchObject({ reason: 'db-unreachable' });
    expect(bootState.decideReadiness({ bootState: state, dbReachable: true, dataDirWritable: false, dataDirDetail: 'EPERM' })).toMatchObject({
      reason: 'data-dir-not-writable',
      detail: 'EPERM',
    });
  });

  test('all checks pass → ready (liveness-only callers may omit live checks)', () => {
    const state = completeBoot();
    expect(bootState.decideReadiness({ bootState: state, dbReachable: true, dataDirWritable: true })).toEqual({
      ready: true,
      reason: null,
      detail: null,
    });
    expect(bootState.decideReadiness({ bootState: state })).toMatchObject({ ready: true });
  });
});

// --- boot phase publishing ---------------------------------------------------

describe('boot phase publishing', () => {
  test('recordPhase keeps the entry and logs its durationMs', () => {
    bootState.beginBoot();
    bootState.recordPhase('schema-sync', 612, { detail: 'synced · in sync' });
    bootState.recordPhase('super-logger', 3, { detail: 'sinks online' });

    const phases = bootState.readBootState()?.phases ?? [];
    expect(phases.map((p) => p.phase)).toEqual(['schema-sync', 'super-logger']);
    expect(phases[0].durationMs).toBe(612);
    expect(phases[0].ok).toBe(true);
    expect(phases[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(logged.join('\n')).toContain('boot phase schema-sync: durationMs=612');
    expect(logged.join('\n')).toContain('boot phase super-logger: durationMs=3');
  });

  test('markBootComplete publishes the total startup interval', () => {
    bootState.beginBoot();
    bootState.recordPhase('process', 5, { detail: 'process start → instrumentation hook' });
    bootState.markBootComplete();
    const state = bootState.readBootState();
    expect(state?.bootComplete).toBe(true);
    expect(typeof state?.totalMs).toBe('number');
    expect(logged.join('\n')).toMatch(/boot complete: durationMs=\d+/);
  });

  test('markBootFailure records the failing phase once (and never hides it)', () => {
    bootState.beginBoot();
    const failure = bootState.markBootFailure('official-bot', new Error('seed exploded'), 42);
    expect(failure.phase).toBe('official-bot');
    const state = bootState.readBootState();
    expect(state?.bootFailure?.message).toBe('seed exploded');
    const failed = (state?.phases ?? []).filter((p) => !p.ok);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ phase: 'official-bot', durationMs: 42, detail: 'seed exploded' });
  });
});

// --- GET /api/ready ----------------------------------------------------------

describe('GET /api/ready', () => {
  test('503 + boot-incomplete before instrumentation has booted', async () => {
    process.env.NURAE_DATA_DIR = tempDir();
    const res = await readyRoute.GET();
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.ready).toBe(false);
    expect(body.reason).toBe('boot-incomplete');
    expect(body.checks).toMatchObject({ bootComplete: false, schemaSync: 'unknown' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  test('200 only when boot facts AND live checks pass (cheap read, phases, no-store)', async () => {
    process.env.NURAE_DATA_DIR = tempDir();
    globalForBoot.__nuraeBootState = completeBoot({
      phases: [{ phase: 'schema-sync', durationMs: 700, at: new Date().toISOString(), ok: true }],
    });

    const res = await readyRoute.GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ready).toBe(true);
    expect(body.reason).toBeNull();
    expect(body.checks).toMatchObject({ bootComplete: true, schemaSync: 'synced', dbReachable: true, dataDirWritable: true });
    expect(body.phases[0]).toMatchObject({ phase: 'schema-sync', durationMs: 700 });
    expect(body.bootMs).toBe(1234);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(queryRawUnsafe).toHaveBeenCalledWith(expect.stringMatching(/SELECT 1/i));
    // The probe file is cleaned up, not left in the data root.
    expect(readdirSync(process.env.NURAE_DATA_DIR).filter((n) => n.startsWith('.nurae-ready-probe'))).toEqual([]);
  });

  test('a green verdict is NEVER cached: the live DB check decides per request', async () => {
    process.env.NURAE_DATA_DIR = tempDir();
    globalForBoot.__nuraeBootState = completeBoot();

    const first = await readyRoute.GET();
    expect(first.status).toBe(200);

    // The database dies right after the green verdict.
    queryRawUnsafe.mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));
    const second = await readyRoute.GET();
    const body = await second.json();
    expect(second.status).toBe(503);
    expect(body.ready).toBe(false);
    expect(body.reason).toBe('db-unreachable');
    expect(body.detail).toContain('SQLITE_BUSY');
    expect(body.checks).toMatchObject({ dbReachable: false, bootComplete: true, schemaSync: 'synced' });
  });

  test('503 + data-dir-not-writable when the data root rejects a probe write', async () => {
    const dir = tempDir();
    const notADirectory = join(dir, 'plain-file');
    writeFileSync(notADirectory, 'not a directory');
    process.env.NURAE_DATA_DIR = notADirectory;
    globalForBoot.__nuraeBootState = completeBoot();

    const res = await readyRoute.GET();
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.reason).toBe('data-dir-not-writable');
    expect(body.checks).toMatchObject({ dataDirWritable: false, dbReachable: true });
  });

  test('a failed boot answers 503 with the phase that failed', async () => {
    process.env.NURAE_DATA_DIR = tempDir();
    globalForBoot.__nuraeBootState = completeBoot({
      bootComplete: false,
      bootFailure: { phase: 'schema-sync', message: 'prisma db push exited 1', at: new Date().toISOString() },
    });
    const res = await readyRoute.GET();
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.reason).toBe('boot-failed');
    expect(body.detail).toContain('schema-sync');
    expect(body.bootFailure).toMatchObject({ phase: 'schema-sync' });
  });
});

// --- GET /api/health (liveness contract + honest readiness) ------------------

describe('GET /api/health', () => {
  test('keeps the liveness contract and adds the boot-scoped readiness verdict', async () => {
    globalForBoot.__nuraeBootState = completeBoot();
    const res = await healthRoute.GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      status: 'ok',
      name: 'NURAE',
      version: 'V00.12.000-beta-01',
      vendor: 'FRAZIYM TECH & AI',
      ready: true,
      readyReason: null,
    });
    expect(typeof body.tagline).toBe('string');
    expect(body.versionParsed).toMatchObject({ raw: 'V00.12.000-beta-01' });
    expect(typeof body.time).toBe('string');
  });

  test('stops implying "ready" while the boot is incomplete or failed', async () => {
    const incomplete = await (await healthRoute.GET()).json();
    expect(incomplete.status).toBe('ok'); // liveness: the process answers
    expect(incomplete.ready).toBe(false);
    expect(incomplete.readyReason).toBe('boot-incomplete');

    globalForBoot.__nuraeBootState = completeBoot({
      bootComplete: false,
      bootFailure: { phase: 'official-fleet', message: 'seed failed', at: new Date().toISOString() },
    });
    const failed = await (await healthRoute.GET()).json();
    expect(failed.status).toBe('ok');
    expect(failed.ready).toBe(false);
    expect(failed.readyReason).toBe('boot-failed');
  });
});
