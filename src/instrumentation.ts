/**
 * NURAE — Next.js instrumentation hook (runs once per server process).
 *
 * Boots deployment-level services that must exist before any bot starts:
 *  1. The official NURAE CS bot seeding (idempotent — creates the
 *     "NURAE Official" project + "NURAE CS Bot" row on first boot).
 *  2. The Gateway Link heartbeat, which registers this deployment's public
 *     origin (NURAE_PUBLIC_BASE_URL) with the linked frontend
 *     (NURAE_LINK_FRONTEND_URL + NURAE_GATEWAY_KEY) and refreshes it every
 *     60 s. See src/lib/nurae/runtime/gateway-link.ts.
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  // NOTE: no node:dns / nodemailer / other Node-only imports here — this file
  // is compiled for BOTH the Node and Edge runtime targets in dev, and any
  // Node module in it trips Turbopack's "not supported in the Edge Runtime"
  // warning on every request. The IPv4-first DNS preference (Android/Termux
  // ENETUNREACH fix) lives in src/lib/nurae/auth/mailer.ts, whose module-scope
  // side effect runs on the Node-only auth routes before any SMTP call.
  const { ensureOfficialBot, migrateLegacyZaiBots } = await import('./lib/nurae/auth/official-bot');
  await ensureOfficialBot();
  const migrated = await migrateLegacyZaiBots();
  if (migrated > 0) console.log(`[NURAE] migrated ${migrated} legacy zai bot(s) to openrouter`);
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
