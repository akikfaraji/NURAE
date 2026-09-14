/**
 * NURAE — Google sign-in, step 2 (public site).
 * GET /api/auth/google/callback?code=…&state=…
 *   Validates the CSRF state cookie, exchanges the code for a profile,
 *   upserts the user (Google accounts are born verified), opens a session
 *   and redirects to `/`. Errors redirect back with ?auth_error=<reason>.
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import {
  clearStateCookie,
  exchangeCodeForProfile,
  googleConfig,
  publicOrigin,
  validState,
} from '@/lib/nurae/auth/google';
import { clientKey, rateLimit } from '@/lib/nurae/auth/rate-limit';
import { createUserSession } from '@/lib/nurae/auth/sessions';
import { ensureSignupTrial } from '@/lib/nurae/billing/wallet';

function fail(origin: string, reason: string): Response {
  return new NextResponse(null, {
    status: 302,
    headers: {
      Location: `${origin}/?auth_error=${encodeURIComponent(reason)}`,
      'Set-Cookie': clearStateCookie(),
      'Cache-Control': 'no-store',
    },
  });
}

export async function GET(req: NextRequest): Promise<Response> {
  const cfg = googleConfig();
  const origin = publicOrigin(req);
  if (!cfg) return fail(origin, 'google-not-configured');

  const rl = rateLimit(`google-cb:${clientKey(req)}`, 20, 10 * 60 * 1000);
  if (!rl.allowed) return fail(origin, 'rate-limited');

  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const oauthError = url.searchParams.get('error');
  if (oauthError) return fail(origin, oauthError === 'access_denied' ? 'cancelled' : oauthError);
  if (!validState(req, state)) return fail(origin, 'invalid-state');
  if (!code) return fail(origin, 'missing-code');

  try {
    const profile = await exchangeCodeForProfile(cfg, code, origin);
    const email = profile.email.toLowerCase();
    const emailVerified = profile.email_verified !== false;

    const existing = await db.user.findUnique({ where: { email } });
    const user = existing
      ? await db.user.update({
          where: { id: existing.id },
          data: {
            googleId: profile.sub,
            emailVerified: existing.emailVerified || emailVerified,
            avatarUrl: profile.picture ?? existing.avatarUrl,
            lastLoginAt: new Date(),
          },
        })
      : await db.user.create({
          data: {
            email,
            name: profile.name?.trim() || email.split('@')[0],
            googleId: profile.sub,
            emailVerified,
            avatarUrl: profile.picture ?? null,
            lastLoginAt: new Date(),
          },
        });

    // Start the 7-day free week (idempotent — never shortened or re-granted).
    await ensureSignupTrial(user.id);

    const res = new NextResponse(null, {
      status: 302,
      headers: {
        Location: `${origin}/?welcome=1`,
        'Set-Cookie': clearStateCookie(),
        'Cache-Control': 'no-store',
      },
    });
    await createUserSession(res, user.id, req.headers.get('user-agent'));
    return res;
  } catch (err) {
    console.error(`[NURAE] google callback failed: ${err instanceof Error ? err.message : String(err)}`);
    return fail(origin, 'google-exchange-failed');
  }
}
