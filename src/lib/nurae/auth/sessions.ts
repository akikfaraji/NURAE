/**
 * NURAE — customer sessions (cookie-backed, DB-persisted).
 *
 * Cookie: nurae_session (HttpOnly, SameSite=Lax, 30 days).
 * The cookie value is a random 32-byte token; the Session row records the
 * owner, device and expiry. Distinct from the admin cookie (nurae_admin) —
 * an admin can browse the public site while their admin session stands.
 */

import { NextResponse } from 'next/server';
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

/** Create a session row + attach the cookie to the response. */
export async function createUserSession(
  res: NextResponse,
  userId: string,
  userAgent: string | null,
): Promise<string> {
  const token = randomToken(32);
  await db.session.create({
    data: {
      userId,
      token,
      userAgent: userAgent ? userAgent.slice(0, 255) : null,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    },
  });
  res.headers.append(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  );
  return token;
}

/** Resolve the session cookie to its user (null when absent/expired). */
export async function sessionUser(req: Request): Promise<SessionUser | null> {
  const token = presentedSessionToken(req);
  if (!token) return null;
  const row = await db.session.findUnique({
    where: { token },
    include: { user: true },
  });
  if (!row) return null;
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
    await db.session.deleteMany({ where: { token } }).catch(() => undefined);
  }
  res.headers.append('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
