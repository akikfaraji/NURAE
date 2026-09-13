/**
 * NURAE — email verification (public site).
 * POST /api/auth/verify { email, code }
 *   → 200 { ok } + user session cookie (auto sign-in after verification).
 *   → 400 invalid/expired code. Rate limited per IP and per account.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { apiError, internalError, validationError } from '@/lib/nurae/api/base';
import { verifyPassword } from '@/lib/nurae/auth/passwords';
import { clientKey, rateLimit } from '@/lib/nurae/auth/rate-limit';
import { createUserSession } from '@/lib/nurae/auth/sessions';
import { qualifyReferralForUser } from '@/lib/nurae/referral';

const BodySchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  code: z.string().trim().regex(/^\d{6}$/, 'The code is 6 digits'),
});

export async function POST(req: Request): Promise<Response> {
  const ipRl = rateLimit(`verify-ip:${clientKey(req)}`, 20, 10 * 60 * 1000);
  if (!ipRl.allowed) {
    return NextResponse.json({ error: `Too many attempts. Try again in ${ipRl.retryAfter}s.` }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError('Invalid JSON body');
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return validationError(parsed.error);
  const { email, code } = parsed.data;

  try {
    const user = await db.user.findUnique({ where: { email } });
    if (!user) return apiError('No pending registration for this email.', 404);
    if (user.emailVerified) {
      return NextResponse.json({ ok: true, alreadyVerified: true });
    }

    const acctRl = rateLimit(`verify-acct:${user.id}`, 8, 10 * 60 * 1000);
    if (!acctRl.allowed) {
      return NextResponse.json({ error: `Too many code attempts. Try again in ${acctRl.retryAfter}s.` }, { status: 429 });
    }

    const tokens = await db.verificationToken.findMany({
      where: { userId: user.id, purpose: 'email_verify', expiresAt: { gt: new Date() } },
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

    await db.$transaction([
      db.verificationToken.deleteMany({ where: { userId: user.id, purpose: 'email_verify' } }),
      db.user.update({ where: { id: user.id }, data: { emailVerified: true, lastLoginAt: new Date() } }),
    ]);

    // The invited account is now real — qualify any pending referral reward
    // and grant the inviter's entitlement (2 days of premium features).
    await qualifyReferralForUser(user.id).catch(() => undefined);

    const res = NextResponse.json({ ok: true });
    await createUserSession(res, user.id, req.headers.get('user-agent'));
    return res;
  } catch (err) {
    return internalError(err, 'auth/verify');
  }
}
