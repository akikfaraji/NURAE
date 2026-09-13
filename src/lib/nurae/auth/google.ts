/**
 * NURAE — Google Sign-In (OAuth 2.0 authorization code flow).
 *
 * Configuration (both required, otherwise the sign-in button is hidden):
 *   NURAE_GOOGLE_CLIENT_ID      OAuth 2.0 Client ID (Web application)
 *   NURAE_GOOGLE_CLIENT_SECRET  matching client secret
 *   NURAE_PUBLIC_URL            optional explicit origin (behind a proxy);
 *                               otherwise derived from the incoming request.
 *
 * Redirect URI to register in Google Cloud Console → Credentials:
 *   <origin>/api/auth/google/callback
 *
 * Implemented by hand (no next-auth): one redirect + one token exchange +
 * one userinfo call. State is a random token stored in a short-lived cookie
 * and compared on callback (CSRF).
 */

import type { NextRequest } from 'next/server';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/userinfo';
export const OAUTH_STATE_COOKIE = 'nurae_oauth_state';
const STATE_TTL_S = 600;

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
}

export function googleConfig(): GoogleConfig | null {
  const clientId = process.env.NURAE_GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.NURAE_GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/** Resolve the public origin for redirect_uri (explicit env wins). */
export function publicOrigin(req: NextRequest | Request): string {
  const explicit = process.env.NURAE_PUBLIC_URL?.trim().replace(/\/+$/, '');
  if (explicit) return explicit;
  if ('nextUrl' in req) {
    const u = new URL(req.url);
    return `${u.protocol}//${u.host}`;
  }
  const proto = req.headers.get('x-forwarded-proto') ?? 'http';
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? 'localhost:3000';
  return `${proto}://${host}`;
}

export function redirectUri(origin: string): string {
  return `${origin}/api/auth/google/callback`;
}

export function googleAuthUrl(cfg: GoogleConfig, origin: string, state: string): string {
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri(origin),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    prompt: 'select_account',
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

export interface GoogleProfile {
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
  picture?: string;
}

export async function exchangeCodeForProfile(
  cfg: GoogleConfig,
  code: string,
  origin: string,
): Promise<GoogleProfile> {
  const tokenRes = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: redirectUri(origin),
      grant_type: 'authorization_code',
    }),
  });
  const tokenData = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!tokenRes.ok || !tokenData.access_token) {
    throw new Error(`Google token exchange failed${tokenData.error ? ` (${tokenData.error})` : ''}`);
  }
  const userRes = await fetch(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  if (!userRes.ok) throw new Error('Google userinfo request failed');
  const profile = (await userRes.json()) as GoogleProfile;
  if (!profile.sub || !profile.email) throw new Error('Google profile is missing required fields');
  return profile;
}

export function stateCookie(value: string): string {
  return `${OAUTH_STATE_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${STATE_TTL_S}`;
}

export function clearStateCookie(): string {
  return `${OAUTH_STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** Read + validate the state cookie against the callback's state param. */
export function validState(req: NextRequest, returned: string | null): boolean {
  if (!returned) return false;
  const cookieValue = req.cookies.get(OAUTH_STATE_COOKIE)?.value;
  return Boolean(cookieValue) && cookieValue === returned;
}
