import { NextResponse } from 'next/server';
import { decideReadiness, readBootState } from '@/lib/nurae/startup/boot-state';
import { NURAE_NAME, NURAE_VENDOR, NURAE_VERSION, NURAE_TAGLINE, parseFraziymVersion } from '@/lib/nurae/version';

/**
 * GET /api/health — LIVENESS, with an honest readiness field.
 *
 * The contract is unchanged and must stay: 200 + status/name/version/vendor/
 * tagline/versionParsed/time whenever the process can answer (gateway.ts and
 * nurae-client/api.ts depend on exactly that). What is new is that the payload
 * no longer implies "ready": it carried a bare {"status":"ok"} while the boot
 * migration was failing, which made it useless as a deploy gate.
 *
 * `ready` / `readyReason` come from the readiness rule in
 * src/lib/nurae/startup/boot-state.ts, fed with the facts the boot published.
 * Deliberately NO live I/O here (liveness must stay cheap): the boot-scoped
 * verdict answers "did this process finish starting, schema settled?", while
 * GET /api/ready re-runs the live checks (DB reachable, data dir writable) on
 * every call. Use /api/ready to gate traffic.
 */
export async function GET() {
  const parsed = parseFraziymVersion(NURAE_VERSION); // validates format at runtime
  const verdict = decideReadiness({ bootState: readBootState() });
  return NextResponse.json({
    status: 'ok',
    ready: verdict.ready,
    readyReason: verdict.reason,
    name: NURAE_NAME,
    version: NURAE_VERSION,
    vendor: NURAE_VENDOR,
    tagline: NURAE_TAGLINE,
    versionParsed: parsed,
    time: new Date().toISOString(),
  });
}
