/**
 * NURAE — transactional email via Gmail SMTP (app password).
 *
 * Configuration (both required, otherwise mail is "not configured" and the
 * registration flow falls back to exposing the code as `devCode`):
 *   NURAE_GMAIL_USER          e.g. you@gmail.com
 *   NURAE_GMAIL_APP_PASSWORD  16-character Google app password
 *
 * Gmail app passwords: Google Account → Security → 2-Step Verification →
 * App passwords. SMTP host is fixed to smtp.gmail.com:465 (implicit TLS).
 */

import { createTransport, type Transporter } from 'nodemailer';

export interface MailConfig {
  user: string;
  pass: string;
}

export function gmailConfig(): MailConfig | null {
  const user = process.env.NURAE_GMAIL_USER?.trim();
  const pass = process.env.NURAE_GMAIL_APP_PASSWORD?.trim();
  if (!user || !pass) return null;
  return { user, pass };
}

let cached: { key: string; transport: Transporter } | null = null;

function transporter(cfg: MailConfig): Transporter {
  const key = `${cfg.user}:${cfg.pass.length}`;
  if (cached && cached.key === key) return cached.transport;
  const transport = createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: cfg.user, pass: cfg.pass },
  });
  cached = { key, transport };
  return transport;
}

export interface SendResult {
  ok: boolean;
  detail: string;
}

/** Send the 6-digit verification code. Never rejects; failures are returned. */
export async function sendVerificationMail(to: string, code: string, siteName: string): Promise<SendResult> {
  const cfg = gmailConfig();
  if (!cfg) return { ok: false, detail: 'Gmail SMTP is not configured.' };
  const subject = `${siteName} — your verification code: ${code}`;
  const text = [
    `Welcome to ${siteName}!`,
    '',
    `Your verification code is:  ${code}`,
    '',
    'It expires in 15 minutes. If you did not request this, ignore this email.',
    '',
    '— NURAE · FRAZIYM TECH & AI',
  ].join('\n');
  const html = [
    '<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#09090b;color:#fafafa;padding:32px;border-radius:12px;max-width:480px">',
    `<h2 style="margin:0 0 8px;font-weight:600">Welcome to ${escapeHtml(siteName)}</h2>`,
    '<p style="color:#a1a1aa;margin:0 0 20px">Enter this code to verify your email:</p>',
    `<div style="font-size:32px;letter-spacing:8px;font-weight:700;background:#18181b;border:1px solid #27272a;border-radius:8px;padding:16px 24px;text-align:center">${code}</div>`,
    '<p style="color:#71717a;font-size:12px;margin:20px 0 0">Expires in 15 minutes. If you did not request this, ignore this email.</p>',
    '<p style="color:#71717a;font-size:12px;margin:4px 0 0">NURAE · FRAZIYM TECH &amp; AI</p>',
    '</div>',
  ].join('\n');
  try {
    await transporter(cfg).sendMail({
      from: `"${siteName}" <${cfg.user}>`,
      to,
      subject,
      text,
      html,
    });
    return { ok: true, detail: 'sent' };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // Structured log; NEVER include the app password (it is not part of err).
    console.error(`[NURAE] verification mail to ${maskEmail(to)} failed: ${detail}`);
    return { ok: false, detail };
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Mask an email for logs: a***b@domain.tld */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  return `${local[0]}***${email.slice(at)}`;
}
