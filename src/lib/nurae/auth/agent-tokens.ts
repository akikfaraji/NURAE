/**
 * NURAE — Bearer API tokens for external AI agents (the "Remote API").
 *
 * An AgentToken is how an agent like Claude operates NURAE over
 * /api/v1/* and /api/mcp: it presents `Authorization: Bearer nrae_…` and
 * NURAE resolves identity from the TOKEN ROW — never from the request body.
 *
 * Security model (mirrors sessions.ts, not the DB-secret pattern):
 *  - Key format: `nrae_` + 43 base62 chars of crypto randomness (~256 bits).
 *    The raw key is returned ONCE at creation; only its SHA-256 hex hash is
 *    stored (a DB leak must not expose live credentials).
 *  - `prefix` (first 12 chars) is the only display-safe fragment.
 *  - Scopes: 'user' acts as its owner (ownerId set, user tool tier);
 *    'platform' is an operator credential (ownerId null, platform tier).
 *  - Revocation is a timestamp — revoked tokens resolve to null, period.
 *  - lastUsedAt touches are throttled (60s) so a busy agent cannot churn
 *    the database with a write per request.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { db } from '@/lib/db';
import type { ToolContext } from '../agents/tools';

// ---------------------------------------------------------------------------
// Key material
// ---------------------------------------------------------------------------

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
/** nrae_ (5) + 43 chars = 48 chars total. */
export const AGENT_KEY_LENGTH = 48;
const KEY_BODY_LENGTH = 43; // 43 × log2(62) ≈ 256 bits

/** Uniform base62 string (rejection sampling — no modulo bias). */
function randomBase62(length: number): string {
  let out = '';
  while (out.length < length) {
    const bytes = randomBytes(length * 2);
    for (const b of bytes) {
      if (out.length >= length) break;
      if (b >= 248) continue; // 62 × 4 = 248 — bytes above are rejected
      out += BASE62[b % 62];
    }
  }
  return out;
}

export function hashAgentKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** Constant-time equality for hash material (defense in depth). */
function hashesEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------------------
// Row shape + DTO (metadata only — never the raw key)
// ---------------------------------------------------------------------------

export interface AgentTokenRowLike {
  id: string;
  name: string;
  prefix: string;
  keyHash: string;
  scope: string;
  ownerId: string | null;
  allowConsequential: boolean;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface AgentTokenDTO {
  id: string;
  name: string;
  prefix: string;
  scope: string;
  allowConsequential: boolean;
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export function toAgentTokenDTO(row: AgentTokenRowLike): AgentTokenDTO {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scope: row.scope,
    allowConsequential: row.allowConsequential,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateAgentTokenInput {
  name: string;
  scope: 'user' | 'platform';
  /** Required for scope 'user'; platform tokens are always ownerless. */
  ownerId?: string | null;
  allowConsequential?: boolean;
}

export interface CreatedAgentToken {
  /** The raw key — shown to the caller EXACTLY once, never stored. */
  token: string;
  row: AgentTokenRowLike;
}

export async function createAgentToken(input: CreateAgentTokenInput): Promise<CreatedAgentToken> {
  const scope = input.scope === 'platform' ? 'platform' : 'user';
  const ownerId = scope === 'platform' ? null : input.ownerId ?? null;
  if (scope === 'user' && !ownerId) {
    throw new Error('A user-scope agent token requires an owner.');
  }
  const token = `nrae_${randomBase62(KEY_BODY_LENGTH)}`;
  const row = await db.agentToken.create({
    data: {
      name: input.name.trim().slice(0, 80) || 'Agent token',
      prefix: token.slice(0, 12),
      keyHash: hashAgentKey(token),
      scope,
      ownerId,
      allowConsequential: Boolean(input.allowConsequential),
    },
  });
  await db.log
    .create({
      data: {
        botId: null,
        level: 'info',
        event: 'AGENT_TOKEN_CREATED',
        message: `Agent token "${row.name}" minted (scope=${row.scope}, prefix=${row.prefix}, allowConsequential=${row.allowConsequential}, owner=${row.ownerId ?? 'platform'}).`,
      },
    })
    .catch(() => undefined);
  return { token, row };
}

// ---------------------------------------------------------------------------
// Resolve (the only door from an HTTP request to an identity)
// ---------------------------------------------------------------------------

/**
 * Resolve `Authorization: Bearer nrae_…` to its AgentToken row.
 * Returns null for missing/malformed/unknown/revoked keys. Touches
 * lastUsedAt at most once per 60s per token.
 */
export async function resolveAgentToken(req: Request): Promise<AgentTokenRowLike | null> {
  const auth = req.headers.get('authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  const key = auth.slice(7).trim();
  if (key.length !== AGENT_KEY_LENGTH || !key.startsWith('nrae_')) return null;
  const hash = hashAgentKey(key);
  const row = await db.agentToken.findUnique({ where: { keyHash: hash } });
  if (!row) return null;
  if (!hashesEqual(row.keyHash, hash)) return null;
  if (row.revokedAt) return null;
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000) {
    await db.agentToken
      .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);
  }
  return row;
}

// ---------------------------------------------------------------------------
// Identity → ToolContext (userId from the row, NEVER from the body)
// ---------------------------------------------------------------------------

/**
 * The ToolContext fragment a token row authorizes. `userId` stays undefined
 * for platform tokens; callers combine it with their own session id and
 * confirmation flag to build the full ToolContext for executeTool.
 */
export function agentTokenContext(row: AgentTokenRowLike): {
  userId?: string;
  platform: boolean;
} {
  return {
    userId: row.ownerId ?? undefined,
    platform: row.scope === 'platform',
  };
}

// ---------------------------------------------------------------------------
// Revoke
// ---------------------------------------------------------------------------

/** Revoke by id. Idempotent; returns the updated row or null when unknown. */
export async function revokeAgentToken(id: string): Promise<AgentTokenRowLike | null> {
  const row = await db.agentToken.findUnique({ where: { id } });
  if (!row) return null;
  if (row.revokedAt) return row;
  const updated = await db.agentToken.update({
    where: { id },
    data: { revokedAt: new Date() },
  });
  await db.log
    .create({
      data: {
        botId: null,
        level: 'info',
        event: 'AGENT_TOKEN_REVOKED',
        message: `Agent token "${updated.name}" revoked (prefix=${updated.prefix}, owner=${updated.ownerId ?? 'platform'}).`,
      },
    })
    .catch(() => undefined);
  return updated;
}
