/**
 * NURAE — customer sign-in with email + password (public site).
 * POST /api/auth/user-login { email, password }
 *   → 200 { ok, user } + session cookie.
 *   → 403 when the email is not verified yet (verification flow restarts).
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { apiError, internalError, validationError } from '@/lib/nurae/api/base';
import { verifyPassword } from '@/lib/nurae/auth/passwords';
import { clientKey, rateLimit } from '@/lib/nurae/auth/rate-limit';
import { createUserSession, toSessionUser } from '@/lib/nurae/auth/sessions';

const BodySchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(128),
});

export async function POST(req: Request): Promise<Response> {
  const rl = rateLimit(`user-login:${clientKey(req)}`, 10, 10 * 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json({ error: `Too many attempts. Try again in ${rl.retryAfter}s.` }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError('Invalid JSON body');
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return validationError(parsed.error);
  const { email, password } = parsed.data;

  try {
    const user = await db.user.findUnique({ where: { email } });
    // Uniform error for unknown email / wrong password / Google-only account
    // (no account enumeration; scrypt runs anyway when there is no hash).
    const ok = user ? await verifyPassword(password, user.passwordHash) : await verifyPassword(password, null);
    if (!ok || !user) return apiError('Invalid email or password.', 401);
    if (!user.emailVerified) {
      return apiError('This email is not verified yet. Register again to receive a fresh code.', 403);
    }

    await db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    const res = NextResponse.json({ ok: true, user: toSessionUser(user) });
    await createUserSession(res, user.id, req.headers.get('user-agent'));
    return res;
  } catch (err) {
    return internalError(err, 'auth/user-login');
  }
}
