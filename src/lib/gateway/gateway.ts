/**
 * NURAE Gateway Link — registration core (frontend side).
 *
 * The backend proves itself with the shared gateway key (NURAE_GATEWAY_KEY)
 * and registers its public origin. Before the link is accepted the frontend
 * verifies the endpoint REALLY serves this application (health check carries
 * the NURAE version) — a leaked key can therefore not silently point the
 * dashboard at a hostile host; it could only point it at another NURAE
 * backend, which then also needs its own credentials to be useful.
 *
 * Key comparison is timing-safe: both sides are hashed with SHA-256 first so
 * the comparison length never depends on the input.
 *
 * These handlers are framework-free (no next/server imports) so they are
 * directly unit-testable; the route files are thin wrappers.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { NURAE_VERSION } from '../nurae/version';
import { effectiveGatewayKey } from './bootstrap-key';
import { blobStore, type GatewayLink, type GatewayStore } from './store';

export interface GatewayResult {
  status: number;
  body: Record<string, unknown>;
}

type FetchLike = typeof fetch;

function keysMatch(presented: string): boolean {
  const expected = effectiveGatewayKey(); // env wins; TEMPORARY bootstrap fallback on Vercel
  if (!expected || !presented) return false;
  const a = createHash('sha256').update(presented, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/** Returns an error message, or null when the endpoint is acceptable. */
function validateEndpoint(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return 'endpoint is required.';
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return 'endpoint is not a valid URL.';
  }
  if (url.protocol !== 'https:') return 'endpoint must be an HTTPS URL.';
  if (url.pathname.replace(/\/+$/, '') !== '') {
    return 'endpoint must be a base origin (no path).';
  }
  return null;
}

/**
 * Verify the endpoint serves THIS application. Returns an error message or
 * null when the backend answered /api/health with a NURAE V00-series version.
 */
export async function verifyBackendHealth(endpoint: string, fetchImpl: FetchLike = fetch): Promise<string | null> {
  let res: Response;
  try {
    res = await fetchImpl(`${endpoint.replace(/\/+$/, '')}/api/health`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    return `backend did not answer /api/health: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (res.status !== 200) return `backend /api/health returned HTTP ${res.status}`;
  let body: { status?: unknown; version?: unknown };
  try {
    body = (await res.json()) as { status?: unknown; version?: unknown };
  } catch {
    return 'backend /api/health returned a non-JSON body.';
  }
  if (body.status !== 'ok') return `backend health status is "${String(body.status)}", expected "ok".`;
  if (typeof body.version !== 'string' || !/^V00\./.test(body.version)) {
    return `backend version "${String(body.version)}" is not a NURAE V00-series release.`;
  }
  return null;
}

/** Injected collaborators for tests (defaults: real fetch + Blob store). */
export interface GatewayDeps {
  fetchImpl?: FetchLike;
  store?: GatewayStore;
}

/** POST /api/gateway/register — the backend announces its public origin. */
export async function handleGatewayRegister(
  payload: unknown,
  deps?: GatewayDeps,
): Promise<GatewayResult> {
  const store = deps?.store ?? blobStore;
  if (!effectiveGatewayKey()) { // TEMPORARY bootstrap fallback keeps this non-501 on Vercel
    return {
      status: 501,
      body: {
        error: 'gateway-not-configured',
        message: 'Set NURAE_GATEWAY_KEY (and connect a Blob store) on this deployment to enable linking.',
      },
    };
  }
  const body = (payload ?? {}) as { endpoint?: unknown; key?: unknown };
  if (!keysMatch(typeof body.key === 'string' ? body.key : '')) {
    return { status: 401, body: { error: 'invalid-gateway-key' } };
  }
  const endpointError = validateEndpoint(body.endpoint);
  if (endpointError) return { status: 422, body: { error: 'invalid-endpoint', message: endpointError } };
  const endpoint = (body.endpoint as string).trim().replace(/\/+$/, '');

  const healthError = await verifyBackendHealth(endpoint, deps?.fetchImpl);
  if (healthError) return { status: 502, body: { error: 'backend-unhealthy', message: healthError } };

  const link: GatewayLink = { endpoint, linkedAt: new Date().toISOString(), version: NURAE_VERSION };
  try {
    await store.write(link);
  } catch (err) {
    return {
      status: 500,
      body: { error: 'link-store-failure', message: err instanceof Error ? err.message : String(err) },
    };
  }
  return { status: 200, body: { linked: true, endpoint, linkedAt: link.linkedAt } };
}

/** DELETE /api/gateway/register — drop the link (key required). */
export async function handleGatewayUnregister(payload: unknown, deps?: GatewayDeps): Promise<GatewayResult> {
  const store = deps?.store ?? blobStore;
  if (!effectiveGatewayKey()) {
    return { status: 501, body: { error: 'gateway-not-configured' } };
  }
  const body = (payload ?? {}) as { key?: unknown };
  if (!keysMatch(typeof body.key === 'string' ? body.key : '')) {
    return { status: 401, body: { error: 'invalid-gateway-key' } };
  }
  try {
    await store.remove();
  } catch (err) {
    return {
      status: 500,
      body: { error: 'link-store-failure', message: err instanceof Error ? err.message : String(err) },
    };
  }
  return { status: 200, body: { linked: false } };
}

/** GET /api/gateway/status — safe to expose publicly (host only, no secrets). */
export async function handleGatewayStatus(deps?: GatewayDeps): Promise<GatewayResult> {
  const gatewayMode = Boolean(effectiveGatewayKey()); // TEMPORARY bootstrap fallback counts on Vercel
  const link = gatewayMode ? await (deps?.store ?? blobStore).read() : null;
  let host: string | null = null;
  if (link) {
    try {
      host = new URL(link.endpoint).host;
    } catch {
      host = null;
    }
  }
  return {
    status: 200,
    body: {
      gatewayMode,
      linked: Boolean(link),
      endpoint: host,
      linkedAt: link?.linkedAt ?? null,
      linkedVersion: link?.version ?? null,
    },
  };
}
