/**
 * NURAE — Bot Runtime service (isolated process, spec §14).
 *
 * Owns the BotManager and every running Telegram bot. The Next.js dashboard/
 * API process talks to this service over a localhost-only HTTP API protected
 * by a shared internal token (NURAE_RUNTIME_TOKEN, auto-generated).
 *
 *           NURAE
 *             │
 *        ┌────┴────┐
 *        │   API   │  (Next.js :3000)
 *        └────┬────┘
 *             │ localhost :3030
 *        Bot Manager
 *       ┌─────┼─────┐
 *     Bot A  Bot B  Bot C
 *       │      │      │
 *   Telegram Telegram Telegram
 *       │      │      │
 *      AI     AI     AI
 */

import { PrismaClient } from '@prisma/client';
import { readFileSync, existsSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { NURAE_VERSION, NURAE_NAME, NURAE_VENDOR, identityLine, startupBanner } from '../../src/lib/nurae/version';
import { createLogger } from '../../src/lib/nurae/logging';
import { createPrismaRuntimeStore } from '../../src/lib/nurae/runtime/store';
import { BotManager } from '../../src/lib/nurae/runtime/bot-manager';

// ---------------------------------------------------------------------------
// Environment bootstrap (mini-service cwd differs from repo root)
// ---------------------------------------------------------------------------

function loadRootEnv(): void {
  const rootEnv = join(import.meta.dir, '..', '..', '.env');
  if (!existsSync(rootEnv)) return;
  const content = readFileSync(rootEnv, 'utf8');
  for (const line of content.split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1];
    const value = m[2].replace(/^["']|["']$/g, '');
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadRootEnv();

const PORT = Number(process.env.NURAE_RUNTIME_PORT || 3030);
const ROOT_DIR = join(import.meta.dir, '..', '..');

// ---------------------------------------------------------------------------
// Internal auth token (gateway exposes :3030 via XTransformPort — protect it)
// ---------------------------------------------------------------------------

function getRuntimeToken(): string {
  if (process.env.NURAE_RUNTIME_TOKEN) return process.env.NURAE_RUNTIME_TOKEN;
  const tokenPath = join(ROOT_DIR, 'db', '.nurae-runtime-token');
  if (existsSync(tokenPath)) {
    return readFileSync(tokenPath, 'utf8').trim();
  }
  const token = randomBytes(32).toString('base64url');
  writeFileSync(tokenPath, token + '\n', { mode: 0o600 });
  try {
    chmodSync(tokenPath, 0o600);
  } catch {
    /* best effort */
  }
  return token;
}
const RUNTIME_TOKEN = getRuntimeToken();

// ---------------------------------------------------------------------------
// Core wiring
// ---------------------------------------------------------------------------

const prisma = new PrismaClient({ log: ['error'] });
const logger = createLogger(prisma, { silent: false });
const store = createPrismaRuntimeStore(prisma);
const manager = new BotManager({ store });

const startedAt = Date.now();

async function initPragmas(): Promise<void> {
  try {
    // PRAGMA statements return rows — use $queryRawUnsafe (not executeRaw).
    await prisma.$queryRawUnsafe('PRAGMA journal_mode=WAL;');
    await prisma.$queryRawUnsafe('PRAGMA busy_timeout=5000;');
  } catch (err) {
    console.warn(`[NURAE] SQLite pragma setup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// HTTP API (localhost service)
// ---------------------------------------------------------------------------

interface ServiceError extends Error {
  statusCode?: number;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // Internal auth: the dashboard process holds the shared token.
  const auth = req.headers.get('authorization') || '';
  if (auth !== `Bearer ${RUNTIME_TOKEN}`) {
    return json({ error: 'Unauthorized' }, 401);
  }

  if (req.method === 'GET' && (path === '/health' || path === '/')) {
    return json({
      name: NURAE_NAME,
      version: NURAE_VERSION,
      vendor: NURAE_VENDOR,
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      managedBots: manager.listStatuses().length,
    });
  }

  if (req.method === 'GET' && path === '/status') {
    return json({ bots: manager.listStatuses() });
  }

  const botMatch = /^\/bots\/([A-Za-z0-9_-]+)(\/status)?$/.exec(path);
  if (req.method === 'GET' && botMatch) {
    const status = manager.statusOf(botMatch[1]);
    return json({ botId: status.botId, status: status.status, startedAt: status.startedAt });
  }

  const actionMatch = /^\/bots\/([A-Za-z0-9_-]+)\/(start|stop|restart)$/.exec(path);
  if (req.method === 'POST' && actionMatch) {
    const [, botId, action] = actionMatch;
    try {
      let status;
      if (action === 'start') status = await manager.startBot(botId);
      else if (action === 'stop') status = await manager.stopBot(botId);
      else status = await manager.restartBot(botId);
      return json({ botId: status.botId, status: status.status });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const notFound = /not found/i.test(message);
      return json({ error: message }, notFound ? 404 : 400);
    }
  }

  return json({ error: 'Not found' }, 404);
}

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    return handle(req).catch((err: ServiceError) => {
      console.error(`[NURAE] internal error: ${err instanceof Error ? err.message : String(err)}`);
      return json({ error: 'Internal runtime error' }, 500);
    });
  },
});

// ---------------------------------------------------------------------------
// Startup message + graceful shutdown (spec §17)
// ---------------------------------------------------------------------------

console.log(startupBanner());
console.log(`Runtime service listening on :${server.port}`);
console.log(identityLine());

async function shutdown(signal: string): Promise<void> {
  console.log(`[NURAE] ${signal} received — shutting down gracefully…`);
  try {
    await manager.stopAll();
    await logger.info(null, `Runtime stopped gracefully after ${signal}. All bots stopped.`);
    await prisma.$disconnect();
  } catch (err) {
    console.error(`[NURAE] shutdown error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// Boot pragmas + startup log entry.
initPragmas().then(() =>
  logger
    .info(null, `Runtime service started (port ${PORT}) — NURAE ${NURAE_VERSION}.`)
    .catch(() => undefined),
);
