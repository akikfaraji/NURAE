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
 */

export async function registerNode(): Promise<void> {
  // FIRST: every later boot failure lands in dev.log (data root → logs/dev.log).
  const { installDevLogger } = await import('./lib/nurae/startup/dev-logger');
  installDevLogger();
  // SECOND: the super logger — structured JSONL + DB + ring + crash capture.
  // From here on EVERY unhandledRejection / uncaughtException is recorded
  // durably (dev.log alone misses hard crashes: Node bypasses console).
  const { installSuperLogger, logBootLine } = await import('./lib/nurae/logging');
  installSuperLogger();
  logBootLine();
  const { syncSqliteSchema } = await import('./lib/nurae/startup/schema-sync');
  await syncSqliteSchema();
  const { ensureOfficialBot, migrateLegacyZaiBots } = await import('./lib/nurae/auth/official-bot');
  await ensureOfficialBot();
  const migrated = await migrateLegacyZaiBots();
  if (migrated > 0) console.log(`[NURAE] migrated ${migrated} legacy zai bot(s) to openrouter`);
  // Official fleet (the five built-in promotion bots as platform-owned rows):
  // env-only links at boot - when no site URL env is set the dashboard's
  // first GET /api/official-bot call seeds lazily with the request origin.
  const { ensureOfficialFleet } = await import('./lib/nurae/auth/official-fleet');
  const fleetSeeded = await ensureOfficialFleet();
  if (fleetSeeded > 0) console.log(`[NURAE] official fleet: seeded ${fleetSeeded} bot(s)`);
  const { gatewayLinkConfigured, startGatewayHeartbeat } = await import('./lib/nurae/runtime/gateway-link');
  if (gatewayLinkConfigured()) {
    startGatewayHeartbeat();
  }
  // Bot task engine (schedules + broadcasts): a 60 s in-process ticker for
  // long-lived deployments. Idempotent per process; serverless deployments
  // sweep the same work after every webhook update instead.
  const { createPrismaRuntimeStore } = await import('./lib/nurae/runtime/store');
  const { startTaskTicker } = await import('./lib/nurae/runtime/tasks');
  const { db } = await import('./lib/db');
  startTaskTicker(createPrismaRuntimeStore(db));
}
