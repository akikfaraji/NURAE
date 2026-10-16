/**
 * NURAE — unforgeable unsubscribe links.
 *
 * A promotional mail must carry a link that lets the recipient stop ALL
 * further promotional mail with one click — and that link must not be
 * forgeable, or anyone could unsubscribe anyone (a denial-of-service on the
 * audience, and a data-integrity problem for the suppression list).
 *
 * Shape:  u1.<base64url(normalised address)>.<hmac-sha256 hex>
 *
 *   - the signature covers the version AND the address, so a tampered address
 *     or a spliced version fails;
 *   - the key is NURAE_SECRET_KEY (the platform master secret), with the same
 *     fallback chain as auth/admin-session.ts so every deployment that has an
 *     admin token also has working unsubscribe links;
 *   - verification is a constant-time compare of equal-length hex digests;
 *   - verification NEVER throws: any structural problem, bad encoding, junk
 *     payload or wrong signature returns null. Callers answer a human page
 *     either way.
 *
 * What the link does NOT contain: the secret (only its HMAC), and any
 * address other than the recipient's own — the payload is the address the
 * mail is already addressed to, so clicking the link tells the server nothing
 * it was not already told by the mail itself. There is no signing oracle
 * here: sign() is server-side only and the token carries no user input.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

const VERSION = 'u1';

/** Same key chain as admin-session: master secret first, admin token as fallback. */
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

/** Local copy of the address rule — this module must not depend on the mail paths. */
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

function normalize(raw: string): string | null {
  const email = (raw ?? '').trim().toLowerCase();
  if (email.length < 6 || email.length > 254 || !EMAIL_RE.test(email)) return null;
  return email;
}

/** True when the deployment has key material to mint and verify tokens with. */
export function unsubscribeConfigured(): boolean {
  return keyMaterial().length > 0;
}

/**
 * Mint the token for one address. Throws when no key is configured — an
 * unsigned link would be forgeable, and a promotional mail without a working
 * unsubscribe link must not be sent at all (the caller treats the throw as
 * "leave it queued", never as "send anyway").
 */
export function signUnsubscribeToken(email: string): string {
  const normalized = normalize(email);
  if (!normalized) throw new Error('signUnsubscribeToken requires a valid email address');
  const key = keyMaterial();
  if (!key) throw new Error('signUnsubscribeToken requires NURAE_SECRET_KEY (or NURAE_ADMIN_TOKEN)');
  const payload = `${VERSION}.${Buffer.from(normalized, 'utf8').toString('base64url')}`;
  return `${payload}.${sign(payload, key)}`;
}

/**
 * Verify a presented token. Returns the normalized address it was minted for,
 * or null — for a tampered payload, a truncated/extra field, a wrong version,
 * a missing key, or plain junk. Never throws.
 */
export function verifyUnsubscribeToken(token: string | null | undefined): string | null {
  if (typeof token !== 'string') return null;
  const parts = token.trim().split('.');
  if (parts.length !== 3) return null;
  const [version, encoded, signature] = parts;
  if (version !== VERSION) return null;
  if (!/^[A-Za-z0-9_-]{1,400}$/.test(encoded)) return null;
  if (!/^[0-9a-f]{64}$/.test(signature)) return null;
  const key = keyMaterial();
  if (!key) return null;
  const expected = sign(`${version}.${encoded}`, key);
  if (!safeEqualHex(expected, signature)) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  // The payload must be an address this system would actually mail — a valid
  // signature over something unmailable is still not a usable unsubscribe.
  return normalize(decoded);
}
