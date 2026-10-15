import { NextRequest, NextResponse } from 'next/server';
import { effectiveGatewayKey } from '@/lib/gateway/bootstrap-key';
import { readGatewayLink } from '@/lib/gateway/store';

/**
 * NURAE Gateway Link — runtime proxy (frontend side).
 *
 * When this deployment opted into gateway mode (NURAE_GATEWAY_KEY is set),
 * every /api/* request — except the /api/gateway/* control routes — is
 * rewritten at REQUEST TIME to the linked backend. This is what makes the
 * frontend static: no build-time backend URL, no redeploy when the backend
 * moves (tunnel restarts, CI runs, new host). The backend re-registers and
 * the next request (≤10 s cache) already flows to the new origin.
 *
 * The rewrite keeps the browser same-origin: no CORS, auth cookies unchanged.
 * When no backend is linked yet the API answers 503 backend-not-linked so
 * the dashboard can show a clear state instead of cryptic failures.
 *
 * Role guard: a deployment that REGISTERS itself with a frontend (i.e. the
 * backend, which carries NURAE_LINK_FRONTEND_URL + NURAE_GATEWAY_KEY) must
 * never proxy its own API — it has no link store of its own and would
 * otherwise answer 503 to its own health checks (and so would the frontend's
 * chain verification). Backend ⇒ proxy is a no-op pass-through.
 *
 * CSRF hardening (defense in depth on top of SameSite=Lax cookies): every
 * state-changing /api/* request that CARRIES an Origin header must be
 * same-origin with the deployment. Requests without an Origin header
 * (server-to-server calls: Telegram webhooks, agent Bearer clients, curl,
 * MCP) pass untouched. The check runs centrally here — before routing —
 * so no route can forget it.
 *
 * Precedence note: the proxy runs before next.config.ts rewrites, so an
 * accepted gateway link wins over a build-time NURAE_BACKEND_URL. Without
 * NURAE_GATEWAY_KEY this proxy is a no-op pass-through and the app
 * behaves exactly as in single-process mode (local dev, Actions runner).
 *
 * Next.js 16.3: the "middleware" file convention was renamed to "proxy"
 * (file src/proxy.ts, exported function `proxy`) — same runtime behaviour.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF origin check. Exposed for tests. Returns a 403 response when a
 * mutating request presents a cross-origin Origin header, else null.
 */
export function csrfCheck(req: NextRequest): NextResponse | null {
  if (SAFE_METHODS.has(req.method)) return null;
  const origin = req.headers.get('origin');
  if (!origin) return null; // non-browser clients (curl, webhooks, Bearer agents)
  let originHost: string | null = null;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return reject();
  }
  const forwardedHost = req.headers.get('x-forwarded-host');
  const host = (forwardedHost ? forwardedHost.split(',')[0].trim() : req.headers.get('host')) ?? '';
  if (originHost && originHost === host.toLowerCase()) return null;
  return reject();
}

function reject(): NextResponse {
  return NextResponse.json(
    { error: 'cross-origin request rejected', message: 'The Origin of this state-changing request does not match the deployment host.' },
    { status: 403 },
  );
}

export async function proxy(req: NextRequest) {
  const csrf = csrfCheck(req);
  if (csrf) return csrf;

  const { pathname, search } = req.nextUrl;
  if (pathname === '/api' || pathname.startsWith('/api/gateway/')) {
    return NextResponse.next(); // control routes are served locally
  }
  if (process.env.NURAE_LINK_FRONTEND_URL) {
    return NextResponse.next(); // I am a registering backend, not a gateway frontend
  }
  if (!effectiveGatewayKey()) {
    return NextResponse.next(); // gateway mode not enabled on this deployment
  }
  const link = await readGatewayLink();
  if (!link) {
    return NextResponse.json(
      { error: 'backend-not-linked', message: 'No backend has registered with this frontend yet.' },
      { status: 503 },
    );
  }
  return NextResponse.rewrite(new URL(`${pathname}${search}`, link.endpoint));
}

export const config = {
  matcher: ['/api', '/api/:path*'],
};
