/**
 * NURAE — GET/POST /api/email/unsubscribe?t=<token>
 *
 * The public end of every promotional mail. Public on purpose: a recipient who
 * never signed in must still be able to stop the mail, with one click, without
 * an account, without a session and without telling us why.
 *
 * Contract:
 *   - the token is verified before ANY write; a tampered, truncated or
 *     unknown-version token answers a readable page and changes nothing;
 *   - the answer is always a small human page with a plain status code — a bad
 *     token is a 400 with an explanation, never a stack trace and never a 500;
 *   - the suppression it writes is terminal and global (see suppression.ts):
 *     campaigns, the operator tool and the invite funnel all stop for that
 *     address;
 *   - a light per-client rate limit keeps this endpoint from being used as an
 *     enumeration oracle (it can only ever answer "valid" or "not valid", so
 *     hammering it must not be cheap);
 *   - GET and POST both act (POST exists for mail clients that one-click POST,
 *     GET for humans) and both are idempotent: unsubscribing twice is the same
 *     as unsubscribing once.
 *
 * Nothing about the click is logged with the address in the clear —
 * suppression.ts stores the address, everything a human reads is masked.
 */

import { NextResponse } from 'next/server';
import { clientKey, rateLimit } from '@/lib/nurae/auth/rate-limit';
import { addSuppression } from '@/lib/nurae/email/suppression';
import { verifyUnsubscribeToken } from '@/lib/nurae/email/unsubscribe-token';

export const runtime = 'nodejs';
// A cached answer to a token URL would unsubscribe one person for everybody.
export const dynamic = 'force-dynamic';

const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;
/** Long enough for a token, short enough that junk is not hashed for nothing. */
const MAX_TOKEN_LENGTH = 512;

const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-robots-tag': 'noindex, nofollow',
} as const;

function siteName(): string {
  return process.env.NURAE_SITE_NAME?.trim() || 'NURAE';
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(inner: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="robots" content="noindex,nofollow"/>
<title>${escapeHtml(siteName())} — email preferences</title>
</head>
<body style="margin:0;background:#09090b;color:#fafafa;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
<main style="max-width:560px;margin:0 auto;padding:48px 24px">
<div style="background:#18181b;border:1px solid #27272a;border-radius:12px;padding:32px">
${inner}
<p style="color:#71717a;font-size:12px;margin:24px 0 0">${escapeHtml(siteName())}</p>
</div>
</main>
</body>
</html>`;
}

function html(body: string, status: number): NextResponse {
  return new NextResponse(body, { status, headers: HTML_HEADERS });
}

function invalidPage(): NextResponse {
  return html(
    page(
      '<h1 style="margin:0 0 12px;font-size:20px">This unsubscribe link is not valid</h1>' +
        '<p style="color:#a1a1aa;margin:0 0 12px;line-height:1.6">The link may have been cut in half by your email client, or changed after it was sent.</p>' +
        '<p style="color:#a1a1aa;margin:0;line-height:1.6">Open the unsubscribe link from the most recent email you received and try again — nothing was changed by this visit.</p>',
    ),
    400,
  );
}

async function tokenFromRequest(req: Request, url: URL): Promise<string | null> {
  const fromQuery = url.searchParams.get('t');
  if (fromQuery) return fromQuery.slice(0, MAX_TOKEN_LENGTH);
  if (req.method !== 'POST') return null;
  const type = req.headers.get('content-type') ?? '';
  try {
    if (type.includes('application/json')) {
      const body = (await req.json()) as { t?: unknown } | null;
      return typeof body?.t === 'string' ? body.t.slice(0, MAX_TOKEN_LENGTH) : null;
    }
    if (type.includes('form')) {
      const form = await req.formData();
      const value = form.get('t');
      return typeof value === 'string' ? value.slice(0, MAX_TOKEN_LENGTH) : null;
    }
  } catch {
    return null; // unreadable body is simply "no token"
  }
  return null;
}

async function handle(req: Request): Promise<NextResponse> {
  try {
    const limit = rateLimit(`unsubscribe:${clientKey(req)}`, RATE_LIMIT, RATE_WINDOW_MS);
    if (!limit.allowed) {
      return html(
        page(
          '<h1 style="margin:0 0 12px;font-size:20px">Too many requests</h1>' +
            `<p style="color:#a1a1aa;margin:0;line-height:1.6">Please wait ${limit.retryAfter} second(s) and open the link again.</p>`,
        ),
        429,
      );
    }

    const url = new URL(req.url);
    const token = await tokenFromRequest(req, url);
    const email = verifyUnsubscribeToken(token);
    if (!email) return invalidPage();

    const outcome = await addSuppression(email, 'unsubscribe', 'unsubscribed from a promotional email link');
    return html(
      page(
        '<h1 style="margin:0 0 12px;font-size:20px">You are unsubscribed</h1>' +
          `<p style="color:#a1a1aa;margin:0 0 12px;line-height:1.6">${escapeHtml(siteName())} will not send you promotional email again${
            outcome.alreadySuppressed ? ' — this address was already on the do-not-mail list, and that has not changed' : ''
          }.</p>` +
          '<p style="color:#a1a1aa;margin:0;line-height:1.6">Mail you need for your own account (such as sign-in verification codes) still works. Nothing else was changed.</p>',
      ),
      200,
    );
  } catch (err) {
    // A raw stack trace must never reach a recipient's browser.
    console.error(`[NURAE] unsubscribe failed: ${err instanceof Error ? err.message : String(err)}`);
    return html(
      page(
        '<h1 style="margin:0 0 12px;font-size:20px">We could not complete that</h1>' +
          '<p style="color:#a1a1aa;margin:0;line-height:1.6">Something went wrong on our side and nothing was changed. Please try the link again in a minute.</p>',
      ),
      500,
    );
  }
}

export async function GET(req: Request): Promise<NextResponse> {
  return handle(req);
}

export async function POST(req: Request): Promise<NextResponse> {
  return handle(req);
}
