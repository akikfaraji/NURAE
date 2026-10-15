/**
 * NURAE — Google sign-in, step 1 (public site).
 * GET /api/auth/google/start → 302 to Google's consent screen.
 *   → JSON 501 when Google sign-in is not configured (the UI hides the
 *     button in that case; direct hits get a clear answer).
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { googleAuthUrl, googleConfig, publicOrigin, stateCookie } from '@/lib/nurae/auth/google';
import { randomToken } from '@/lib/nurae/auth/passwords';
import { clientKey, rateLimit } from '@/lib/nurae/auth/rate-limit';

export async function GET(req: NextRequest): Promise<Response> {
  const rl = rateLimit(`google-start:${clientKey(req)}`, 20, 10 * 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json({ error: `Too many attempts. Try again in ${rl.retryAfter}s.` }, { status: 429 });
  }

  const cfg = googleConfig();
  if (!cfg) {
    return NextResponse.json(
      {
        error: 'Google sign-in is not configured. Set NURAE_GOOGLE_CLIENT_ID and NURAE_GOOGLE_CLIENT_SECRET.',
      },
      { status: 501 },
    );
  }

  const origin = publicOrigin(req);
  const state = randomToken(24);
  // Secure hint: https requests (direct or via proxy) get a Secure cookie.
  const proto = req.headers.get('x-forwarded-proto')?.split(',')[0].trim()
    ?? (process.env.NURAE_PUBLIC_URL?.startsWith('https://') ? 'https' : 'http');
  return new NextResponse(null, {
    status: 302,
    headers: {
      Location: googleAuthUrl(cfg, origin, state),
      'Set-Cookie': stateCookie(state, proto === 'https'),
      'Cache-Control': 'no-store',
    },
  });
}
