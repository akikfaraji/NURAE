/**
 * NURAE — admin: live log tailing for the Super Logger.
 *
 * GET /api/admin/logs/tail?level=error&q=bot&limit=100&source=ring|file
 *
 *   source=ring (default) — the in-memory ring buffer: the last entries the
 *   process logged, zero latency, survives nothing (restart clears it).
 *   source=file — a bounded tail-scan of logs/nurae.jsonl: the durable
 *   structured history (rotated generations included in future iterations).
 *
 * Both accept:
 *   level — minimum level (debug|info|warn|error|fatal)
 *   q     — substring filter over domain/event/message/data
 *   limit — max entries (1..2000, default 200)
 *
 * Auth: the standard admin guard (NURAE_ADMIN_TOKEN or signed admin cookie;
 * fails closed with 503 in production when unconfigured). Log contents can
 * contain sensitive operation detail — this surface is deliberately admin-only.
 */

import { NextResponse } from 'next/server';
import { guard, internalError } from '@/lib/nurae/api/base';
import { logger, type SuperLevel } from '@/lib/nurae/logging';

const LEVELS = new Set(['debug', 'info', 'warn', 'error', 'fatal']);

export async function GET(req: Request): Promise<Response> {
  try {
    const denied = guard(req);
    if (denied) return denied;

    const url = new URL(req.url);
    const levelParam = url.searchParams.get('level');
    const level = levelParam && LEVELS.has(levelParam) ? (levelParam as SuperLevel) : undefined;
    const q = url.searchParams.get('q')?.trim() || undefined;
    const limitRaw = Number(url.searchParams.get('limit') ?? '200');
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(Math.trunc(limitRaw), 2000)) : 200;
    const source = url.searchParams.get('source') === 'file' ? 'file' : 'ring';

    const entries = source === 'file' ? logger.queryFileLogs({ level, q, limit }) : logger.recent({ level, q, limit });

    return NextResponse.json({
      source,
      file: source === 'file' ? logger.jsonlPath() : undefined,
      count: entries.length,
      entries,
    });
  } catch (err) {
    return internalError(err, 'admin.logs.tail');
  }
}
