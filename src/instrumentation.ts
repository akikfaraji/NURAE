/**
 * NURAE — Next.js instrumentation hook (runs once per server process).
 *
 * Boots deployment-level services that must exist before any bot starts.
 * Today that is exactly one: the Gateway Link heartbeat, which registers
 * this deployment's public origin (NURAE_PUBLIC_BASE_URL) with the linked
 * frontend (NURAE_LINK_FRONTEND_URL + NURAE_GATEWAY_KEY) and refreshes it
 * every 60 s. See src/lib/nurae/runtime/gateway-link.ts.
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { gatewayLinkConfigured, startGatewayHeartbeat } = await import('./lib/nurae/runtime/gateway-link');
  if (gatewayLinkConfigured()) {
    startGatewayHeartbeat();
  }
}
