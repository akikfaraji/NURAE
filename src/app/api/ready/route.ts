import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import { dataRoot } from '@/lib/paths';
import { decideReadiness, processUpTimeMs, readBootState } from '@/lib/nurae/startup/boot-state';
import { NURAE_VERSION } from '@/lib/nurae/version';

/**
 * GET /api/ready — can this deployment actually SERVE traffic?
 *
 * Why it exists: /api/health is a static 200 (it answered {"status":"ok"}
 * even while the boot migration was failing), and the launcher prints
 * "✓ Ready in 0ms" ~5 s before the first request is answered, so nothing in
 * the system could honestly gate on readiness.
 *
 * This route answers 200 {ready:true, …} ONLY when every check passes, and
 * 503 {ready:false, reason, detail} otherwise, with the reason naming the
 * failed check:
 *
 *   boot-incomplete           instrumentation has not finished starting
 *   boot-failed               a boot phase threw (the phase is in `detail`)
 *   schema-sync-failed        the boot schema push failed
 *   schema-sync-unavailable   file: DB and no prisma CLI/schema to push with
 *   db-unreachable            the cheap live read (SELECT 1) failed
 *   data-dir-not-writable     the data root rejected a probe write
 *
 * Two sources, one verdict:
 *  - boot facts (schema settled, boot finished) come from the state the boot
 *    published (startup/boot-state.ts) — the schema sync is work, not a
 *    per-request check, so it is never redone here;
 *  - liveness facts (DB reachable, data dir writable) are re-run on EVERY
 *    request, so a `true` from an earlier moment is never recycled: a DB that
 *    died after boot turns this route red immediately.
 */

export const runtime = 'nodejs';
// A cached readiness verdict is a lie — never prerender, never store.
export const dynamic = 'force-dynamic';

/** Cheap liveness read: one trivial statement, no table access, no side effects. */
async function dbReachable(): Promise<{ ok: boolean; detail?: string }> {
  try {
    const { db } = await import('@/lib/db');
    await db.$queryRawUnsafe('SELECT 1');
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message.split('\n')[0] : String(err),
    };
  }
}

/**
 * Probe write: NURAE grows its database and appends logs under the data root,
 * so "writable" is the real question — an fs.access(W_OK) check does not prove
 * a create succeeds (read-only mount, revoked ACL, full disk). One throwaway
 * file per request, deleted in `finally`.
 */
function dataDirWritable(): { ok: boolean; detail?: string } {
  const dir = dataRoot();
  const probe = join(dir, `.nurae-ready-probe-${process.pid}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(probe, String(Date.now()));
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    try {
      rmSync(probe, { force: true });
    } catch {
      /* the probe is best-effort cleanup, never a readiness failure */
    }
  }
}

export async function GET(): Promise<NextResponse> {
  const bootState = readBootState();
  const dbCheck = await dbReachable();
  const dirCheck = dataDirWritable();

  const verdict = decideReadiness({
    bootState,
    dbReachable: dbCheck.ok,
    dbDetail: dbCheck.detail,
    dataDirWritable: dirCheck.ok,
    dataDirDetail: dirCheck.detail,
  });

  return NextResponse.json(
    {
      ready: verdict.ready,
      reason: verdict.reason,
      detail: verdict.detail,
      checks: {
        bootComplete: bootState?.bootComplete ?? false,
        schemaSync: bootState?.schemaSync?.status ?? 'unknown',
        dbReachable: dbCheck.ok,
        dataDirWritable: dirCheck.ok,
      },
      // The boot timeline: each phase with its durationMs, so a probe (or a
      // human) can see WHERE the startup interval goes.
      phases: bootState?.phases ?? [],
      bootMs: bootState?.totalMs ?? null,
      uptimeMs: processUpTimeMs(),
      bootFailure: bootState?.bootFailure ?? null,
      pid: process.pid,
      version: NURAE_VERSION,
      time: new Date().toISOString(),
    },
    { status: verdict.ready ? 200 : 503, headers: { 'Cache-Control': 'no-store' } },
  );
}
