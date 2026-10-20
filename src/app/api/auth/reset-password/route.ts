/**
 * NURAE — password reset confirmation (public site).
 * POST /api/auth/reset-password { email, code, newPassword }
 *   → 200 { ok } + session cookie (auto sign-in).
 *   → 400 invalid/expired code.
 *   → 429 rate limited.
 *
 * Verifies the 6-digit code issued by /api/auth/forgot-password, sets the new
 * password hash, deletes all reset tokens for the account, and creates a
 * session so the user lands directly in the dashboard.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { apiError, internalError, validationError } from '@/lib/nurae/api/base';
import { hashPassword, verifyPassword } from '@/lib/nurae/auth/passwords';
import { clientKey, rateLimit } from '@/lib/nurae/auth/rate-limit';
import { createUserSession, secureHint, toSessionUser } from '@/lib/nurae/auth/sessions';

const BodySchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  code: z.string().trim().regex(/^\d{6}$/, 'The code is 6 digits'),
  newPassword: z.string().min(8).max(128),
});

export async function POST(req: Request): Promise<Response> {
  const ipRl = rateLimit(`reset-pw-ip:${clientKey(req)}`, 10, 10 * 60 * 1000);
  if (!ipRl.allowed) {
    return NextResponse.json(
      { error: `Too many attempts. Try again in ${ipRl.retryAfter}s.` },
      { status: 429 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError('Invalid JSON body');
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return validationError(parsed.error);
  const { email, code, newPassword } = parsed.data;

  try {
    const user = await db.user.findUnique({ where: { email } });
    if (!user || !user.emailVerified) {
      return apiError('Invalid or expired code. Request a new one.', 400);
    }

    const acctRl = rateLimit(`reset-pw-acct:${user.id}`, 8, 10 * 60 * 1000);
    if (!acctRl.allowed) {
      return NextResponse.json(
        { error: `Too many code attempts. Try again in ${acctRl.retryAfter}s.` },
        { status: 429 },
      );
    }

    const tokens = await db.verificationToken.findMany({
      where: { userId: user.id, purpose: 'password_reset', expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });

    let matched: string | null = null;
    for (const t of tokens) {
      if (await verifyPassword(code, t.codeHash)) {
        matched = t.id;
        break;
      }
    }
    if (!matched) return apiError('Invalid or expired code. Request a new one.', 400);

    const newHash = await hashPassword(newPassword);

    await db.$transaction([
      db.verificationToken.deleteMany({ where: { userId: user.id, purpose: 'password_reset' } }),
      db.user.update({
        where: { id: user.id },
        data: { passwordHash: newHash, lastLoginAt: new Date() },
      }),
    ]);

    const res = NextResponse.json({ ok: true, user: toSessionUser(user) });
    await createUserSession(res, user.id, req.headers.get('user-agent'), secureHint(req));
    return res;
  } catch (err) {
    return internalError(err, 'auth/reset-password');
  }
}
