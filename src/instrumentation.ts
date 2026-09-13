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
  const { ensureOfficialBot } = await import('./lib/nurae/auth/official-bot');
  await ensureOfficialBot();
  const { gatewayLinkConfigured, startGatewayHeartbeat } = await import('./lib/nurae/runtime/gateway-link');
  if (gatewayLinkConfigured()) {
    startGatewayHeartbeat();
  }
}
