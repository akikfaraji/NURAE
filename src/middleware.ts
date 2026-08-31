import { NextRequest, NextResponse } from 'next/server';
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
 * chain verification). Backend ⇒ middleware is a no-op pass-through.
 *
 * Precedence note: middleware runs before next.config.ts rewrites, so an
 * accepted gateway link wins over a build-time NURAE_BACKEND_URL. Without
 * NURAE_GATEWAY_KEY this middleware is a no-op pass-through and the app
 * behaves exactly as in single-process mode (local dev, Actions runner).
 */

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (pathname === '/api' || pathname.startsWith('/api/gateway/')) {
    return NextResponse.next(); // control routes are served locally
  }
  if (process.env.NURAE_LINK_FRONTEND_URL) {
    return NextResponse.next(); // I am a registering backend, not a gateway frontend
  }
  if (!process.env.NURAE_GATEWAY_KEY) {
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
