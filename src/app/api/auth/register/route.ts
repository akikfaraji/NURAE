/**
 * NURAE — customer registration (public site).
 * POST /api/auth/register { name, email, password }
 *   → 200 { ok, devCode?, mailError?, mailHint? }
 *       devCode  ONLY when Gmail SMTP is not configured (localhost mode)
 *       mailError/mailHint ONLY when SMTP is configured but the send FAILED —
 *       the UI must never claim a code is "on its way" when it is not.
 *   → 409 when the email is taken (verified account).
 * A 6-digit code (scrypt-hashed, 15 min TTL) is emailed via Gmail SMTP.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { apiError, internalError, validationError } from '@/lib/nurae/api/base';
import { hashPassword, numericCode } from '@/lib/nurae/auth/passwords';
import { gmailConfig, sendVerificationMail, maskEmail, mailFailureHint } from '@/lib/nurae/auth/mailer';
import { clientKey, rateLimit } from '@/lib/nurae/auth/rate-limit';
import { getSiteInfo } from '@/lib/nurae/auth/settings';
import { recordReferralSignup } from '@/lib/nurae/referral';
import { ensureSignupTrial } from '@/lib/nurae/billing/wallet';

const BodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8).max(128),
  // Referral code from the invite link (?ref=CODE) — optional, never trusted
  // beyond "record who invited whom"; qualification happens at verification.
  ref: z.string().trim().max(32).optional(),
});

const CODE_TTL_MS = 15 * 60 * 1000;

export async function POST(req: Request): Promise<Response> {
  const rl = rateLimit(`register:${clientKey(req)}`, 10, 10 * 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: `Too many attempts. Try again in ${rl.retryAfter}s.` },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
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
  const { name, email, password, ref } = parsed.data;

  try {
    const existing = await db.user.findUnique({ where: { email } });
    if (existing?.emailVerified) {
      return apiError('An account with this email already exists. Sign in instead.', 409);
    }

    const passwordHash = await hashPassword(password);
    const user = existing
      ? await db.user.update({ where: { id: existing.id }, data: { name, passwordHash } })
      : await db.user.create({ data: { name, email, passwordHash } });

    // Record the invite (if any). Guards inside: unknown code / self-invite /
    // duplicate invited user all no-op. The reward only QUALIFIES at verify.
    await recordReferralSignup(user.id, ref);

    // Start the 7-day free week (idempotent — never shortened or re-granted).
    await ensureSignupTrial(user.id);

    // Invalidate previous codes, issue a fresh one (hashed — never stored plain).
    await db.verificationToken.deleteMany({ where: { userId: user.id, purpose: 'email_verify' } });
    const code = numericCode(6);
    await db.verificationToken.create({
      data: {
        userId: user.id,
        codeHash: await hashPassword(code),
        purpose: 'email_verify',
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
      },
    });

    const site = await getSiteInfo();
    const sent = await sendVerificationMail(email, code, site.siteName);
    if (!sent.ok) {
      console.warn(`[NURAE] verification code for ${maskEmail(email)} NOT emailed: ${sent.detail}`);
    }

    const payload: { ok: true; devCode?: string; notice?: string; mailError?: string; mailHint?: string } = { ok: true };
    if (!gmailConfig()) {
      // Localhost/dev mode — without this the flow would be a dead end.
      payload.devCode = code;
      payload.notice = 'Gmail SMTP is not configured (NURAE_GMAIL_USER / NURAE_GMAIL_APP_PASSWORD). Dev code shown.';
    } else if (!sent.ok) {
      // SMTP configured but the send failed — say so plainly. Never leak the
      // app password; the hint names the env vars and the fix.
      payload.mailError = mailFailureHint(sent.detail);
    }
    return NextResponse.json(payload);
  } catch (err) {
    return internalError(err, 'auth/register');
  }
}
