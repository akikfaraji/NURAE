/**
 * NURAE — password-reset request (public site).
 * POST /api/auth/forgot-password { email }
 *   → 200 { ok, devCode? }  always 200 (no account enumeration).
 *
 * Issues a 6-digit code (scrypt-hashed, 15 min TTL) via Gmail SMTP.
 * Any previously issued password-reset token for the account is revoked first.
 * Google-only accounts (no passwordHash) are silently skipped — the response
 * is still 200 so we do not reveal which emails are registered.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { internalError, validationError } from '@/lib/nurae/api/base';
import { hashPassword, numericCode } from '@/lib/nurae/auth/passwords';
import { gmailConfig, sendSiteMail, maskEmail, mailFailureHint } from '@/lib/nurae/auth/mailer';
import { clientKey, rateLimit } from '@/lib/nurae/auth/rate-limit';
import { getSiteInfo } from '@/lib/nurae/auth/settings';

const BodySchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
});

const CODE_TTL_MS = 15 * 60 * 1000;

function devCodeAllowed(): boolean {
  return process.env.NODE_ENV !== 'production' || process.env.NURAE_ALLOW_DEV_CODE === '1';
}

export async function POST(req: Request): Promise<Response> {
  const rl = rateLimit(`forgot-pw:${clientKey(req)}`, 5, 10 * 60 * 1000);
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
    return NextResponse.json({ ok: true }); // still 200 — no enumeration
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return validationError(parsed.error);
  const { email } = parsed.data;

  try {
    const user = await db.user.findUnique({ where: { email } });

    // Unknown email, unverified account, or Google-only account — respond OK
    // without giving away whether the account exists.
    if (!user || !user.emailVerified || !user.passwordHash) {
      return NextResponse.json({ ok: true });
    }

    // Per-account damping (5 requests per 10 min per mailbox).
    const acctRl = rateLimit(`forgot-pw-acct:${user.id}`, 5, 10 * 60 * 1000);
    if (!acctRl.allowed) {
      // Still 200 — do not reveal the rate limit discriminates per account.
      return NextResponse.json({ ok: true });
    }

    // Revoke any previous reset codes, issue a fresh one.
    await db.verificationToken.deleteMany({ where: { userId: user.id, purpose: 'password_reset' } });
    const code = numericCode(6);
    await db.verificationToken.create({
      data: {
        userId: user.id,
        codeHash: await hashPassword(code),
        purpose: 'password_reset',
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
      },
    });

    const site = await getSiteInfo();
    const subject = `${site.siteName} — reset your password`;
    const text = [
      `Hi ${user.name || 'there'},`,
      '',
      'We received a request to reset your NURAE password.',
      '',
      `Your reset code is:  ${code}`,
      '',
      'It expires in 15 minutes. If you did not request this, ignore this email — your password has not changed.',
      '',
      `— ${site.siteName} · FRAZIYM TECH & AI`,
    ].join('\n');
    const html = [
      '<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#09090b;color:#fafafa;padding:32px;border-radius:12px;max-width:480px">',
      `<h2 style="margin:0 0 8px;font-weight:600">Reset your password</h2>`,
      '<p style="color:#a1a1aa;margin:0 0 20px">Enter this code on the NURAE sign-in page to set a new password:</p>',
      `<div style="font-size:32px;letter-spacing:8px;font-weight:700;background:#18181b;border:1px solid #27272a;border-radius:8px;padding:16px 24px;text-align:center">${code}</div>`,
      '<p style="color:#71717a;font-size:12px;margin:20px 0 0">Expires in 15 minutes. If you did not request this, ignore this email — your password has not changed.</p>',
      `<p style="color:#71717a;font-size:12px;margin:4px 0 0">${site.siteName} · FRAZIYM TECH &amp; AI</p>`,
      '</div>',
    ].join('\n');

    const sent = await sendSiteMail(email, subject, text, html, site.siteName);
    if (!sent.ok) {
      console.warn(`[NURAE] password-reset mail to ${maskEmail(email)} NOT sent: ${sent.detail}`);
    }

    const payload: { ok: true; devCode?: string; mailError?: string } = { ok: true };
    if (!gmailConfig()) {
      if (devCodeAllowed()) {
        payload.devCode = code;
      }
      // In production without SMTP and without opt-in: silently skip —
      // the user will see "check your email" but no code arrives; the
      // operator must configure SMTP to make this work.
    } else if (!sent.ok) {
      payload.mailError = mailFailureHint(sent.detail);
    }

    return NextResponse.json(payload);
  } catch (err) {
    return internalError(err, 'auth/forgot-password');
  }
}
