/**
 * NURAE - Node.js-only instrumentation body.
 *
 * Imported from src/instrumentation.ts behind a compile-time
 * `process.env.NEXT_RUNTIME === 'nodejs'` check, so the Edge bundle never
 * sees this module (or nodemailer / Prisma / fs, which are Node-only).
 *
 * Boots deployment-level services that must exist before any bot starts:
 *  1. The official NURAE CS bot seeding (idempotent - creates the
 *     "NURAE Official" project + "NURAE CS Bot" row on first boot).
 *  2. The Gateway Link heartbeat, which registers this deployment's public
 *     origin (NURAE_PUBLIC_BASE_URL) with the linked frontend
 *     (NURAE_LINK_FRONTEND_URL + NURAE_GATEWAY_KEY) and refreshes it every
 *     60 s. See src/lib/nurae/runtime/gateway-link.ts.
 *
 * Every phase reports a durationMs through startup/boot-state.ts, which also
 * publishes the outcome that GET /api/ready and GET /api/health report — the
 * launcher's "✓ Ready in 0ms" appears ~5 s before the first request is
 * answered, so the boot must be measurable and its readiness claimable.
 */

// Type-only import: erased at compile time, so the Edge bundle still never
// sees a Node-only module here.
import type { BootPhaseName } from './lib/nurae/startup/boot-state';

export async function registerNode(): Promise<void> {
  const boot = await import('./lib/nurae/startup/boot-state');
  boot.beginBoot();
  // Phase 0: everything already spent before this hook ran (Node startup, Next
  // bootstrap, module loading) — process.uptime() is the only honest anchor.
  boot.recordPhase('process', boot.processUpTimeMs(), { detail: 'process start → instrumentation hook' });

  // Tracks which phase a throw came from, so a failed boot can NAME the phase.
  let currentPhase: BootPhaseName = 'process';
  let phaseStart = Date.now();
  const enter = (phase: BootPhaseName): void => {
    currentPhase = phase;
    phaseStart = Date.now();
  };

  try {
    // FIRST: every later boot failure lands in dev.log (data root → logs/dev.log).
    enter('dev-logger');
    const { installDevLogger } = await import('./lib/nurae/startup/dev-logger');
    installDevLogger();
    boot.recordPhase('dev-logger', Date.now() - phaseStart, { detail: 'console → dev.log mirror' });

    // SECOND: the schema sync — BEFORE the super logger.
    // WHY this order (boot defect, fresh install): the super logger's DB sink
    // writes every entry into the `logs` table. Installing it first made the
    // sink's first drain hit a table that does not exist yet on a brand-new
    // data dir:
    //   prisma:error Invalid `prisma.log.create()` invocation:
    //     SQLITE_ERROR: no such table: main.logs
    //   [NURAE] log DB sink unavailable for 60s: …
    // — a scary boot error and 60 s of a dead durable sink on EVERY fresh
    // install. The sink must be impossible to write before the schema exists,
    // so the schema is settled first; nothing between here and the logger
    // install touches the database. The sync cannot take the boot down (it
    // reports instead, see schema-sync.ts) and the readiness route publishes
    // its outcome.
    enter('schema-sync');
    const { syncSqliteSchemaDetailed } = await import('./lib/nurae/startup/schema-sync');
    const sync = await syncSqliteSchemaDetailed();
    boot.markSchemaSync(sync);
    boot.recordPhase('schema-sync', Date.now() - phaseStart, {
      ok: sync.ok,
      detail: `${sync.status} · ${sync.detail}`,
    });

    // THIRD: the super logger — structured JSONL + DB + ring + crash capture.
    // From here on EVERY unhandledRejection / uncaughtException is recorded
    // durably (dev.log alone misses hard crashes: Node bypasses console).
    enter('super-logger');
    const { installSuperLogger, logBootLine } = await import('./lib/nurae/logging');
    installSuperLogger();
    logBootLine();
    boot.recordPhase('super-logger', Date.now() - phaseStart, { detail: 'crash capture + JSONL/DB/ring sinks online' });

    enter('official-bot');
    const { ensureOfficialBot, migrateLegacyZaiBots } = await import('./lib/nurae/auth/official-bot');
    await ensureOfficialBot();
    const migrated = await migrateLegacyZaiBots();
    if (migrated > 0) console.log(`[NURAE] migrated ${migrated} legacy zai bot(s) to openrouter`);
    boot.recordPhase('official-bot', Date.now() - phaseStart, {
      detail: migrated > 0 ? `migrated ${migrated} legacy zai bot(s)` : 'official CS bot ready',
    });

    // Official fleet (the five built-in promotion bots as platform-owned rows):
    // env-only links at boot - when no site URL env is set the dashboard's
    // first GET /api/official-bot call seeds lazily with the request origin.
    enter('official-fleet');
    const { ensureOfficialFleet } = await import('./lib/nurae/auth/official-fleet');
    const fleetSeeded = await ensureOfficialFleet();
    if (fleetSeeded > 0) console.log(`[NURAE] official fleet: seeded ${fleetSeeded} bot(s)`);
    boot.recordPhase('official-fleet', Date.now() - phaseStart, {
      detail: fleetSeeded > 0 ? `seeded ${fleetSeeded} bot(s)` : 'already seeded',
    });

    enter('gateway-link');
    const { gatewayLinkConfigured, startGatewayHeartbeat } = await import('./lib/nurae/runtime/gateway-link');
    const linked = gatewayLinkConfigured();
    if (linked) {
      startGatewayHeartbeat();
    }
    boot.recordPhase('gateway-link', Date.now() - phaseStart, {
      detail: linked ? 'heartbeat started' : 'not configured',
    });

    // Bot task engine (schedules + broadcasts): a 60 s in-process ticker for
    // long-lived deployments. Idempotent per process; serverless deployments
    // sweep the same work after every webhook update instead.
    enter('ticker');
    const { createPrismaRuntimeStore } = await import('./lib/nurae/runtime/store');
    const { startTaskTicker } = await import('./lib/nurae/runtime/tasks');
    const { db } = await import('./lib/db');
    startTaskTicker(createPrismaRuntimeStore(db));
    boot.recordPhase('ticker', Date.now() - phaseStart, { detail: 'task ticker started (60s)' });

    // Everything a serving NURAE needs has run: /api/ready may now say yes
    // (after its own live checks) and /api/health stops reporting otherwise.
    boot.markBootComplete();
  } catch (err) {
    // Never swallow: remember the failing phase for readiness, then rethrow so
    // Next.js still surfaces the boot failure like it did before.
    boot.markBootFailure(currentPhase, err, Date.now() - phaseStart);
    throw err;
  }
}
