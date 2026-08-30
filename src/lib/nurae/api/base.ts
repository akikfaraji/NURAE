/**
 * NURAE — API support: auth guard, error mapping, DTOs.
 *
 * Security model (spec §18):
 *  - If NURAE_ADMIN_TOKEN is set, every administrative endpoint requires it
 *    (HttpOnly cookie after login, or Authorization: Bearer).
 *  - If unset (localhost development mode), admin endpoints are open — and the
 *    dashboard shows a warning banner. Never treat this as production-ready.
 *  - Secrets are never selected into API responses (see toBotDTO).
 */

import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { formatZodError } from '../validation';

export const ADMIN_COOKIE = 'nurae_admin';

export function adminToken(): string | null {
  const t = process.env.NURAE_ADMIN_TOKEN;
  return t && t.trim().length > 0 ? t.trim() : null;
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
 * Return a 401 response when auth is enabled and the credential is wrong;
 * return null when the request may proceed.
 */
export function guard(req: Request): NextResponse | null {
  const expected = adminToken();
  if (!expected) return null; // localhost dev mode
  const presented = presentedCredential(req);
  if (presented && safeEqual(presented, expected)) return null;
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
  status: string;
  statusDetail: string | null;
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
  telegramTokenRef: string;
  apiKeyRef: string | null;
  baseUrl: string | null;
  systemPrompt: string;
  provider: string;
  model: string;
  temperature: number;
  maxTokens: number;
  memorySize: number;
  enabled: boolean;
  status: string;
  statusDetail: string | null;
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
    status: row.status,
    statusDetail: row.statusDetail,
    lastStartedAt: row.lastStartedAt ? row.lastStartedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
