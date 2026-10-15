/**
 * NURAE — server-signed admin session cookie.
 *
 * Hardening: the admin cookie used to carry the RAW NURAE_ADMIN_TOKEN, so any
 * cookie exfiltration (log echo, XSS, hostile gateway link) leaked the
 * permanent credential itself. Now login mints a signed, expiring blob:
 *
 *     v1.<expiryEpochMs>.<hmac-sha256(payload, key)>
 *
 *  - The raw token never appears in the cookie (exfil reveals nothing to
 *    reuse offline beyond the 7-day window).
 *  - The signature is verified with HMAC-SHA256 and a timing-safe compare.
 *  - Key material: NURAE_SECRET_KEY when set (the platform master secret),
 *    otherwise the admin token itself. Rotation of either invalidates all
 *    outstanding admin cookies — which is exactly the desired behavior.
 *  - Authorization: Bearer <raw token> keeps working for scripts/CI; only
 *    the COOKIE path accepts the signed form.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const ADMIN_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, matches the cookie Max-Age

const VERSION = 'v1';

function keyMaterial(): string {
  return process.env.NURAE_SECRET_KEY?.trim() || process.env.NURAE_ADMIN_TOKEN?.trim() || '';
}

function sign(payload: string, key: string): string {
  return createHmac('sha256', key).update(payload).digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Mint a signed admin-session value for the cookie. */
export function signAdminSession(now = Date.now()): string {
  const key = keyMaterial();
  if (!key) throw new Error('signAdminSession requires NURAE_ADMIN_TOKEN (or NURAE_SECRET_KEY)');
  const exp = now + ADMIN_SESSION_TTL_MS;
  const payload = `${VERSION}.${exp}`;
  return `${payload}.${sign(payload, key)}`;
}

/**
 * Verify a presented admin-session value. Returns true only when the
 * structure is valid, the signature matches and the window has not expired.
 */
export function verifyAdminSession(value: string | null | undefined, now = Date.now()): boolean {
  if (!value) return false;
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return false;
  const exp = Number(parts[1]);
  if (!Number.isSafeInteger(exp) || exp <= now || exp > now + ADMIN_SESSION_TTL_MS * 2) return false;
  const key = keyMaterial();
  if (!key) return false;
  const payload = `${parts[0]}.${parts[1]}`;
  return safeEqualHex(sign(payload, key), parts[2]);
}
