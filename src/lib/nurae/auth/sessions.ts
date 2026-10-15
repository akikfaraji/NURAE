/**
 * NURAE — customer sessions (cookie-backed, DB-persisted).
 *
 * Cookie: nurae_session (HttpOnly, SameSite=Lax, 30 days, Secure on https).
 * The cookie value is a random 32-byte token; the Session row stores only its
 * SHA-256 hash (same discipline as AgentTokens), so a DB/backup leak can no
 * longer be replayed as live sessions. Legacy rows created before this
 * hardening stored the plaintext token — they are transparently upgraded to
 * hashed form the first time the holder presents them, so no one is logged
 * out by the migration. Distinct from the admin cookie (nurae_admin) — an
 * admin can browse the public site while their admin session stands.
 */

import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { db } from '@/lib/db';
import { randomToken } from './passwords';

export const SESSION_COOKIE = 'nurae_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  avatarUrl: string | null;
  hasPassword: boolean;
  createdAt: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * `Secure` cookie hint: attach Secure only when the request arrived over
 * HTTPS (directly or behind a proxy that sets x-forwarded-proto). Plain-HTTP
 * localhost / LAN deployments keep working unchanged.
 */
export function secureHint(req: Request): boolean {
  const proto = req.headers.get('x-forwarded-proto');
  if (proto) return proto.split(',')[0].trim() === 'https';
  try {
    return new URL(req.url).protocol === 'https:';
  } catch {
    return false;
  }
}

function sessionCookie(token: string, maxAgeS: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${secure ? '; Secure' : ''}`;
}

/** Create a session row + attach the cookie to the response. */
export async function createUserSession(
  res: NextResponse,
  userId: string,
  userAgent: string | null,
  secure = false,
): Promise<string> {
  const token = randomToken(32);
  await db.session.create({
    data: {
      userId,
      token: sha256(token), // hashed at rest — the cookie IS the only copy
      userAgent: userAgent ? userAgent.slice(0, 255) : null,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    },
  });
  res.headers.append('Set-Cookie', sessionCookie(token, Math.floor(SESSION_TTL_MS / 1000), secure));
  return token;
}

/** Resolve the session cookie to its user (null when absent/expired). */
export async function sessionUser(req: Request): Promise<SessionUser | null> {
  const token = presentedSessionToken(req);
  if (!token) return null;
  const hashed = sha256(token);
  let row = await db.session.findUnique({ where: { token: hashed }, include: { user: true } });
  if (!row) {
    // Legacy plaintext row from before the hashing migration: look it up and
    // upgrade it in place so the same cookie keeps working, now hash-backed.
    const legacy = await db.session.findUnique({ where: { token }, include: { user: true } });
    if (!legacy) return null;
    await db.session
      .update({ where: { id: legacy.id }, data: { token: hashed } })
      .catch(() => undefined);
    row = legacy;
  }
  if (row.expiresAt.getTime() <= Date.now()) {
    await db.session.delete({ where: { id: row.id } }).catch(() => undefined);
    return null;
  }
  return toSessionUser(row.user);
}

export function toSessionUser(user: {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  avatarUrl: string | null;
  passwordHash: string | null;
  createdAt: Date;
}): SessionUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    emailVerified: user.emailVerified,
    avatarUrl: user.avatarUrl,
    hasPassword: Boolean(user.passwordHash),
    createdAt: user.createdAt.toISOString(),
  };
}

export function presentedSessionToken(req: Request): string | null {
  const cookie = req.headers.get('cookie') || '';
  const match = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`).exec(cookie);
  return match ? decodeURIComponent(match[1]) : null;
}

/** Delete the current session (logout) and clear the cookie. */
export async function destroyUserSession(req: Request, res: NextResponse): Promise<void> {
  const token = presentedSessionToken(req);
  if (token) {
    // Cover both hashed (current) and legacy plaintext rows.
    await db.session.deleteMany({ where: { token: sha256(token) } }).catch(() => undefined);
    await db.session.deleteMany({ where: { token } }).catch(() => undefined);
  }
  const secure = secureHint(req);
  res.headers.append('Set-Cookie', sessionCookie('', 0, secure));
}
