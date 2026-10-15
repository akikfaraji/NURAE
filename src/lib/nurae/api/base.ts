/**
 * NURAE — API support: auth guard, error mapping, DTOs.
 *
 * Security model (spec §18):
 *  - If NURAE_ADMIN_TOKEN is set, every administrative endpoint requires it
 *    (HttpOnly signed cookie after login, or Authorization: Bearer).
 *  - If unset, admin endpoints are open ONLY outside production (localhost
 *    dev, CI). In production the platform FAILS CLOSED with 503 — an
 *    operator who forgot the env var gets a loud, actionable error instead
 *    of a silently unprotected dashboard.
 *  - The placeholder from .env.example is treated as unset (fail-closed).
 *  - Secrets are never selected into API responses (see toBotDTO).
 */

import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { formatZodError } from '../validation';
import { verifyAdminSession } from '../auth/admin-session';

export const ADMIN_COOKIE = 'nurae_admin';

/** The shipped example value — an operator who kept it has no protection. */
const PLACEHOLDER_TOKENS = new Set(['change-me-if-exposed', 'changeme', 'change-me']);

export function adminToken(): string | null {
  const t = process.env.NURAE_ADMIN_TOKEN;
  const trimmed = t?.trim();
  if (!trimmed) return null;
  if (PLACEHOLDER_TOKENS.has(trimmed.toLowerCase())) return null;
  return trimmed;
}

/** True when admin requests without a token must be REJECTED (production). */
export function requireAdminAuth(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * Secure-cookie hint: attach `Secure` when the request arrived over HTTPS
 * (directly or via a proxy that sets x-forwarded-proto). Plain-HTTP local
 * deployments (localhost / LAN dev) keep working unchanged.
 */
export function secureCookieHint(req: Request): boolean {
  const proto = req.headers.get('x-forwarded-proto');
  if (proto) return proto.split(',')[0].trim() === 'https';
  try {
    return new URL(req.url).protocol === 'https:';
  } catch {
    return false;
  }
}

export function authEnabled(): boolean {
  return adminToken() !== null;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Timing-safe string comparison for credential checks. */
export function safeCompare(a: string, b: string): boolean {
  return safeEqual(a, b);
}

/** Extract the presented credential from cookie or Authorization header. */
export function presentedCredential(req: Request): string | null {
  const cookieHeader = req.headers.get('cookie') || '';
  const match = new RegExp(`(?:^|;\\s*)${ADMIN_COOKIE}=([^;]+)`).exec(cookieHeader);
  if (match) return decodeURIComponent(match[1]);
  const auth = req.headers.get('authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

/**
 * Return an error response when the request may not proceed; return null
 * when it may.
 *
 *  - NURAE_ADMIN_TOKEN set → credential required (raw token via Bearer, or
 *    the signed session cookie minted by /api/auth/login).
 *  - Unset → open ONLY in non-production (dev/CI); in production this fails
 *    closed with 503 so an unconfigured deployment can never serve an
 *    unprotected admin API to the internet.
 */
export function guard(req: Request): NextResponse | null {
  const expected = adminToken();
  if (!expected) {
    if (requireAdminAuth()) {
      return NextResponse.json(
        {
          error:
            'Admin API is locked: NURAE_ADMIN_TOKEN is not configured. Set it in the environment (production refuses to expose an open admin API).',
        },
        { status: 503 },
      );
    }
    return null; // localhost dev mode
  }
  const presented = presentedCredential(req);
  if (presented && safeEqual(presented, expected)) return null;
  if (presented && verifyAdminSession(presented)) return null; // signed cookie
  return NextResponse.json({ error: 'Unauthorized. Log in with the admin token.' }, { status: 401 });
}

// ---------------------------------------------------------------------------
// Validation error mapping
// ---------------------------------------------------------------------------

export function validationError(err: z.ZodError): NextResponse {
  return NextResponse.json({ error: 'Validation failed', fields: formatZodError(err) }, { status: 422 });
}

export function apiError(message: string, status = 400): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

/** Uniform 500 for unexpected failures — details stay in logs, not responses. */
export function internalError(err: unknown, context: string): NextResponse {
  console.error(`[NURAE] ${context}: ${err instanceof Error ? err.message : String(err)}`);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

// ---------------------------------------------------------------------------
// DTOs — secrets can never leak because they are never selected in
// ---------------------------------------------------------------------------

export interface BotDTO {
  id: string;
  projectId: string;
  name: string;
  description: string;
  telegramUsername: string | null;
  hasTelegramToken: boolean;
  hasApiKey: boolean;
  baseUrl: string | null;
  systemPrompt: string;
  provider: string;
  model: string;
  temperature: number;
  maxTokens: number;
  memorySize: number;
  enabled: boolean;
  /** Owner's own Telegram chat id for instant alerts (null = off). */
  ownerChatId: string | null;
  status: string;
  statusDetail: string | null;
  /** Transport used at last start: "webhook" | "polling" (null: never started). */
  transport: string | null;
  lastStartedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// Minimal structural type of a Prisma Bot row used by the DTO mapper.
export interface BotRowLike {
  id: string;
  projectId: string;
  name: string;
  description: string;
  telegramUsername: string | null;
  telegramTokenRef: string | null;
  apiKeyRef: string | null;
  baseUrl: string | null;
  systemPrompt: string;
  provider: string;
  model: string;
  temperature: number;
  maxTokens: number;
  memorySize: number;
  enabled: boolean;
  ownerChatId: string | null;
  status: string;
  statusDetail: string | null;
  transport: string | null;
  lastStartedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export function toBotDTO(row: BotRowLike): BotDTO {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    description: row.description,
    telegramUsername: row.telegramUsername,
    hasTelegramToken: Boolean(row.telegramTokenRef),
    hasApiKey: Boolean(row.apiKeyRef),
    baseUrl: row.baseUrl,
    systemPrompt: row.systemPrompt,
    provider: row.provider,
    model: row.model,
    temperature: row.temperature,
    maxTokens: row.maxTokens,
    memorySize: row.memorySize,
    enabled: row.enabled,
    ownerChatId: row.ownerChatId ?? null,
    status: row.status,
    statusDetail: row.statusDetail,
    transport: row.transport,
    lastStartedAt: row.lastStartedAt ? row.lastStartedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
