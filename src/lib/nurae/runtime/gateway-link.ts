/**
 * NURAE Gateway Link — backend side.
 *
 * When NURAE_LINK_FRONTEND_URL and NURAE_GATEWAY_KEY are configured, the
 * backend registers its public origin (NURAE_PUBLIC_BASE_URL) with the
 * frontend at POST /api/gateway/register and refreshes the registration
 * every 60 s. Tunnel origins are per-boot, so the heartbeat is what keeps
 * a static frontend permanently pointed at the current backend.
 *
 * The link is deployment-level state, not per-bot: it is established the
 * first time a bot goes live in webhook mode (the moment the public base
 * URL has proven itself) and survives individual bot stops.
 *
 * Structured log events: GATEWAY_LINKED / GATEWAY_LINK_FAILED (botId null —
 * this is platform state, visible in the overview log stream).
 */

const HEARTBEAT_MS = 60_000;

const globalForLinker = globalThis as unknown as {
  nuraeGatewayTimer?: ReturnType<typeof setInterval>;
  nuraeGatewayInFlight?: Promise<void>;
};

export function gatewayLinkConfigured(): boolean {
  return Boolean(process.env.NURAE_LINK_FRONTEND_URL?.trim() && process.env.NURAE_GATEWAY_KEY?.trim());
}

async function log(level: 'info' | 'warn' | 'error', message: string, event: string): Promise<void> {
  // Mirror to stdout so server logs (CI artifacts, `node server.js` consoles)
  // show the link lifecycle — the DB log stream is only visible in the UI.
  const line = `[gateway] ${event} ${message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  const { db } = await import('@/lib/db');
  await db.log.create({ data: { botId: null, level, message, event } }).catch(() => undefined);
}

/** One registration attempt. Resolves quietly; failures are logged, never thrown. */
async function registerOnce(): Promise<void> {
  const frontend = (process.env.NURAE_LINK_FRONTEND_URL || '').trim().replace(/\/+$/, '');
  const key = (process.env.NURAE_GATEWAY_KEY || '').trim();
  const endpoint = (process.env.NURAE_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!frontend || !key || !endpoint) return;
  try {
    const res = await fetch(`${frontend}/api/gateway/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint, key }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    if (res.ok) {
      await log('info', `Gateway link established: frontend ${frontend} now proxies to ${endpoint}.`, 'GATEWAY_LINKED');
    } else {
      await log(
        'warn',
        `Gateway registration rejected (HTTP ${res.status} ${body.error ?? ''}): ${body.message ?? 'no detail'}. Retrying.`,
        'GATEWAY_LINK_FAILED',
      );
    }
  } catch (err) {
    await log(
      'warn',
      `Gateway registration failed: ${err instanceof Error ? err.message : String(err)}. Retrying.`,
      'GATEWAY_LINK_FAILED',
    );
  }
}

/** Fire-and-forget one attempt, deduplicating concurrent runs. */
function poke(): void {
  if (globalForLinker.nuraeGatewayInFlight) return;
  globalForLinker.nuraeGatewayInFlight = registerOnce().finally(() => {
    globalForLinker.nuraeGatewayInFlight = undefined;
  });
}

/** Begin the registration heartbeat (no-op when not configured / already running). */
export function startGatewayHeartbeat(): void {
  if (!gatewayLinkConfigured() || globalForLinker.nuraeGatewayTimer) return;
  poke(); // immediate first attempt — do not block the bot start path on it
  globalForLinker.nuraeGatewayTimer = setInterval(poke, HEARTBEAT_MS);
  globalForLinker.nuraeGatewayTimer.unref?.();
}

export function stopGatewayHeartbeat(): void {
  if (globalForLinker.nuraeGatewayTimer) {
    clearInterval(globalForLinker.nuraeGatewayTimer);
    globalForLinker.nuraeGatewayTimer = undefined;
  }
}
