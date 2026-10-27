/**
 * NURAE — Super Logger: the ONE permanent logging system.
 *
 * Design goal (owner mandate): capture EVERY error, structured, durably,
 * forever — "a logging system we can even use later no matter what".
 *
 * One entry point, four sinks, zero-throw:
 *
 *   logger.info/error/... ─┬─▶ console echo (identity line) — mirrored into
 *   │                        logs/dev.log by startup/dev-logger.ts
 *   │                      ├─▶ logs/nurae.jsonl — STRUCTURED lines, rotated
 *   │                      │    (default 10 MB × 5 generations) — machine-
 *   │                      │    readable history that survives reboots
 *   │                      ├─▶ DB Log table — queryable from the dashboard,
 *   │                      │    fire-and-forget queue with failure cooldown
 *   │                      └─▶ in-memory ring buffer — last 500 entries for
 *   │                           instant "what just broke" tailing
 *
 * Every entry is a structured record:
 *   { ts, level, domain, event?, message, botId?, requestId?, durationMs?,
 *     data?, error?{name,message,stack} }
 *
 * Guarantees (inherited from dev-logger's proven rules, extended):
 *  - NEVER throws, NEVER recurses: every sink is individually try/caught and
 *    self-disables on failure (disk full, permissions, DB down);
 *  - secrets never reach storage: values under secret-ish keys (password,
 *    token, apiKey, authorization, cookie, …) are deep-redacted, all text
 *    truncated through the shared sanitizer;
 *  - level filtering via NURAE_LOG_LEVEL (debug|info|warn|error), default info;
 *  - crash capture: unhandledRejection AND uncaughtException are recorded
 *    (structured + file-synced) before the process exits — today a hard crash
 *    never reaches dev.log because Node does not route it through console;
 *  - queryable later: logger.recent() (ring), logger.queryFileLogs() (JSONL
 *    tail) and GET /api/admin/logs/tail (admin-guarded HTTP surface).
 *
 * Env knobs: NURAE_LOG_LEVEL, NURAE_LOG_JSONL=0 (disable file sink),
 * NURAE_LOG_DB=0 (disable DB sink), NURAE_LOG_CRASH_EXIT=0 (log crashes
 * without exiting — default exit(1) preserves Node's crash semantics).
 */

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { formatWithOptions } from 'node:util';
import { resolveDataPath } from '@/lib/paths';
import { identityLine, NURAE_VERSION } from './version';
import { sanitizeForLog, truncateForLog } from './sanitize';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SuperLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/** DB Log table only supports info | warn | error. */
type DbLevel = 'info' | 'warn' | 'error';

export interface LogError {
  name: string;
  message: string;
  stack?: string;
}

export interface LogEntry {
  ts: string;
  level: SuperLevel;
  /** Subsystem that produced the entry: api, agent, bot, ai, db, process… */
  domain: string;
  /** Optional structured event code (e.g. API_INTERNAL_ERROR, BOT_START). */
  event?: string;
  message: string;
  botId?: string | null;
  requestId?: string;
  durationMs?: number;
  data?: unknown;
  error?: LogError;
}

/** Accepted by every level method: a string shorthand or a full record. */
export type LogInput = string | Omit<LogEntry, 'ts' | 'level'>;

export interface LogScope {
  domain?: string;
  botId?: string | null;
  requestId?: string;
}

export interface SuperLoggerOptions {
  /** Directory for the JSONL sink (default: <data root>/logs). */
  dir?: string;
  /** JSONL file name (default: nurae.jsonl). */
  file?: string;
  /** Rotate the JSONL at this size (default 10 MB). */
  rotateBytes?: number;
  /** JSONL generations kept (default 5: nurae.jsonl.1 … .5). */
  keepGenerations?: number;
  /** Ring-buffer capacity (default 500). */
  ringSize?: number;
  /** Minimum level (default from NURAE_LOG_LEVEL or 'info'). */
  level?: SuperLevel;
  /** Per-sink overrides (defaults from env; test runs default them off). */
  sinks?: { console?: boolean; jsonl?: boolean; db?: boolean };
  /** Pre-wired Log store (tests) — otherwise the db client is imported lazily. */
  dbStore?: LegacyLogStore;
}

export interface SuperLogger {
  debug(input: LogInput, data?: unknown): void;
  info(input: LogInput, data?: unknown): void;
  warn(input: LogInput, data?: unknown): void;
  error(input: LogInput, data?: unknown): void;
  fatal(input: LogInput, data?: unknown): void;
  /** Scoped child: every entry inherits domain/botId/requestId. */
  child(scope: LogScope): SuperLogger;
  /** Ring buffer snapshot, newest LAST, filtered. */
  recent(opts?: { level?: SuperLevel; q?: string; limit?: number }): LogEntry[];
  /** Bounded tail-scan of the JSONL file (never throws). */
  queryFileLogs(opts?: { level?: SuperLevel; q?: string; limit?: number; maxBytes?: number }): LogEntry[];
  /** The JSONL path (for the admin tail API). */
  jsonlPath(): string;
  /** Sink health for readiness checks (never throws, never blocks). */
  health(): LogSinkHealth;
  /** Best-effort DB queue drain (awaited by graceful shutdown paths). */
  flush(): Promise<void>;
  /** Test escape hatch: close fds, drop crash listeners. */
  close(): void;
}

/** Sink health snapshot — what readiness/diagnostic surfaces need to know. */
export interface LogSinkHealth {
  level: SuperLevel;
  jsonl: { enabled: boolean; path: string; usingFallbackDir: boolean };
  db: { enabled: boolean; degraded: boolean; queued: number };
  ring: { entries: number; capacity: number };
}

/** Minimal Prisma surface for the DB sink (structural typing, mock-friendly). */
export interface LegacyLogStore {
  log: {
    create(args: { data: { botId: string | null; level: string; event?: string; message: string } }): Promise<unknown>;
  };
}

// ---------------------------------------------------------------------------
// Constants + helpers
// ---------------------------------------------------------------------------

const LEVEL_ORDER: Record<SuperLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };
const LEVEL_PREFIX: Record<SuperLevel, string> = { debug: 'DEBUG', info: 'INFO', warn: 'WARN', error: 'ERROR', fatal: 'FATAL' };
const DB_LEVEL: Record<SuperLevel, DbLevel> = { debug: 'info', info: 'info', warn: 'warn', error: 'error', fatal: 'error' };

/** Values under these keys never reach any sink. */
const SECRET_KEY = /pass(word)?|secret|token|api[-_]?key|apikey|authorization|auth|cookie|credential|bearer/i;
const REDACTED = '[redacted]';
const MAX_DEPTH = 6;
const MAX_OBJ_ITEMS = 40;

/** Deep redaction + depth/size capping — safe on circular and exotic values. */
export function redactDeep(value: unknown, depth = 0): unknown {
  try {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return value.length > 2000 ? truncateForLog(value) : value;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value;
    if (typeof value === 'function') return '[function]';
    if (value instanceof Error) {
      return { name: value.name, message: value.message, stack: typeof value.stack === 'string' ? value.stack.slice(0, 2000) : undefined };
    }
    if (depth >= MAX_DEPTH) return '[depth]';
    if (Array.isArray(value)) return value.slice(0, MAX_OBJ_ITEMS).map((v) => redactDeep(v, depth + 1));
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object') {
      const out: Record<string, unknown> = {};
      let n = 0;
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (n++ >= MAX_OBJ_ITEMS) { out['…'] = '[truncated]'; break; }
        out[k] = SECRET_KEY.test(k) ? REDACTED : redactDeep(v, depth + 1);
      }
      return out;
    }
    return String(value);
  } catch {
    return '[unserializable]';
  }
}

/** Stable stringify that survives BigInt / circular / exotic payloads. */
export function stringifySafe(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 0) ?? 'null';
  } catch {
    try {
      return formatWithOptions({ depth: 4 }, value);
    } catch {
      return '[unformattable]';
    }
  }
}

function envLevel(): SuperLevel {
  const raw = process.env.NURAE_LOG_LEVEL?.trim().toLowerCase();
  return raw === 'debug' ? 'debug' : raw === 'warn' ? 'warn' : raw === 'error' ? 'error' : 'info';
}

function jsonlEnabledByDefault(): boolean {
  const flag = process.env.NURAE_LOG_JSONL?.trim().toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'off') return false;
  if (flag === '1' || flag === 'true' || flag === 'on') return true;
  return process.env.NODE_ENV !== 'test';
}

function dbEnabledByDefault(): boolean {
  const flag = process.env.NURAE_LOG_DB?.trim().toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'off') return false;
  if (flag === '1' || flag === 'true' || flag === 'on') return true;
  return process.env.NODE_ENV !== 'test';
}

// ---------------------------------------------------------------------------
// Core factory
// ---------------------------------------------------------------------------

export function createSuperLogger(opts: SuperLoggerOptions = {}): SuperLogger {
  const minLevel = opts.level ?? envLevel();
  const ringSize = Math.max(2, Math.min(opts.ringSize ?? 500, 5000));
  const rotateBytes = Math.max(64 * 1024, opts.rotateBytes ?? 10 * 1024 * 1024);
  const keepGenerations = Math.max(1, Math.min(opts.keepGenerations ?? 5, 20));

  const consoleSink = opts.sinks?.console ?? true;
  const jsonlSink = opts.sinks?.jsonl ?? (opts.file || opts.dir ? true : jsonlEnabledByDefault());
  const dbSink = opts.dbStore ? true : opts.sinks?.db ?? dbEnabledByDefault();

  const ring: LogEntry[] = [];
  const scope: LogScope = {};

  // --- JSONL sink state -----------------------------------------------------
  let jsonlDisabled = false;
  let jsonlFd: number | null = null;
  let jsonlBytes = 0; // bytes appended since this fd was opened (mid-run rotation)
  let jsonlFallback = false;
  let jsonlWarned = false;
  // NOTE: the fs/path calls below carry `/*turbopackIgnore: true*/` comments.
  // These sinks write to RUNTIME-resolved paths (resolveDataPath → data root,
  // which differs per environment). Turbopack's static tracer cannot scope
  // them, so without the ignore comments it traces the WHOLE PROJECT into
  // every server bundle (8 "Dynamic filesystem access causes tracing of the
  // whole project" warnings on Vercel → bloated serverless functions). The
  // comments are inert at runtime — they only opt the call out of build-time
  // tracing, per Turbopack's official remedy.
  const dir = opts.dir ?? resolveDataPath(join(/*turbopackIgnore: true*/ 'logs'));
  const fileName = opts.file ?? 'nurae.jsonl';
  let filePath = join(/*turbopackIgnore: true*/ dir, fileName);

  function jsonlPath(): string {
    return filePath;
  }

  /**
   * A degraded sink must ANNOUNCE itself exactly once. The previous behaviour
   * set a disabled flag and said nothing anywhere — on a read-only filesystem
   * (e.g. a serverless deployment directory) file logging died permanently and
   * silently, which is the one failure mode a logger must never have.
   */
  function warnSinkOnce(what: string, err: unknown): void {
    if (jsonlWarned) return;
    jsonlWarned = true;
    try {
      process.stderr.write(
        `[NURAE] ${what}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    } catch { /* even stderr can fail — nothing left to do */ }
  }

  function ensureJsonlFd(): number | null {
    if (jsonlFd !== null) return jsonlFd;
    if (jsonlDisabled) return null;
    try {
      mkdirSync(dir, { recursive: true });
      if (existsSync(/*turbopackIgnore: true*/ filePath) && statSync(/*turbopackIgnore: true*/ filePath).size > rotateBytes) {
        // Shift generations: .4→.5, .3→.4, … current→.1
        for (let i = keepGenerations; i >= 1; i--) {
          const from = i === 1 ? filePath : `${filePath}.${i - 1}`;
          const to = `${filePath}.${i}`;
          try {
            if (existsSync(/*turbopackIgnore: true*/ to)) unlinkSync(/*turbopackIgnore: true*/ to);
            if (existsSync(/*turbopackIgnore: true*/ from)) renameSync(/*turbopackIgnore: true*/ from, to);
          } catch {
            /* best-effort rotation */
          }
        }
      }
      jsonlFd = openSync(/*turbopackIgnore: true*/ filePath, 'a');
      return jsonlFd;
    } catch (err) {
      // Read-only data root (serverless / ephemeral filesystems) → fall back to
      // the OS temp dir ONCE and say so, instead of going silent forever.
      if (!jsonlFallback && !opts.dir) {
        try {
          jsonlFallback = true;
          const fallback = join(tmpdir(), 'nurae-logs');
          mkdirSync(fallback, { recursive: true });
          filePath = join(/*turbopackIgnore: true*/ fallback, fileName);
          jsonlFd = openSync(/*turbopackIgnore: true*/ filePath, 'a');
          warnSinkOnce(`log directory "${dir}" is not writable — structured logs now go to "${filePath}"`, err);
          return jsonlFd;
        } catch { /* fall through to the hard disable below */ }
      }
      jsonlDisabled = true;
      warnSinkOnce(`structured JSONL logging DISABLED (target was "${filePath}")`, err);
      return null;
    }
  }

  function writeJsonl(line: string): void {
    const fd = ensureJsonlFd();
    if (fd === null) return;
    try {
      appendFileSync(fd, line + '\n');
      // BYTES, not UTF-16 code units: the variable is a byte budget, and
      // emoji/CJK in Telegram text made the old count under-report badly.
      jsonlBytes += Buffer.byteLength(line, 'utf8') + 1;
      // Mid-run rotation: the fd lives as long as the process, so size-based
      // rotation must ALSO happen while writing — close, and let the next
      // ensureJsonlFd() shift generations (size is now over the threshold).
      if (jsonlBytes >= rotateBytes) {
        try { closeSync(fd); } catch { /* already gone */ }
        jsonlFd = null;
        jsonlBytes = 0;
      }
    } catch (err) {
      jsonlDisabled = true;
      try { closeSync(jsonlFd!); } catch { /* already gone */ }
      jsonlFd = null;
      warnSinkOnce(`structured JSONL logging DISABLED after a write failure ("${filePath}")`, err);
    }
  }

  // --- DB sink state --------------------------------------------------------
  const dbQueue: { botId: string | null; level: DbLevel; event: string; message: string }[] = [];
  const DB_QUEUE_MAX = 200;
  const DB_COOLDOWN_MS = 60_000;
  let dbCooldownUntil = 0;
  let dbWarnedAt = 0;
  let dbFlushScheduled = false;
  let dbStoreOverride: LegacyLogStore | undefined = opts.dbStore;

  function enqueueDb(entry: LogEntry): void {
    if (dbQueue.length >= DB_QUEUE_MAX) dbQueue.shift(); // drop oldest — never block
    dbQueue.push({
      botId: entry.botId ?? null,
      level: DB_LEVEL[entry.level],
      event: (entry.event ?? `${entry.domain.toUpperCase()}_${entry.level.toUpperCase()}`).slice(0, 60),
      message: buildDbMessage(entry),
    });
    scheduleDbFlush();
  }

  function buildDbMessage(entry: LogEntry): string {
    const parts = [`[${entry.domain}]`, entry.message];
    if (entry.requestId) parts.push(`req=${entry.requestId}`);
    if (entry.durationMs !== undefined) parts.push(`(${entry.durationMs}ms)`);
    if (entry.data !== undefined) parts.push(stringifySafe(redactDeep(entry.data)).slice(0, 800));
    if (entry.error) parts.push(`error=${entry.error.name}: ${entry.error.message}`);
    return truncateForLog(sanitizeForLog(parts.join(' ')));
  }

  function scheduleDbFlush(): void {
    if (dbFlushScheduled) return;
    dbFlushScheduled = true;
    const t = setTimeout(() => {
      dbFlushScheduled = false;
      void drainDb();
    }, 25);
    // Never hold the process open for a log flush.
    t.unref?.();
  }

  async function drainDb(): Promise<void> {
    if (dbQueue.length === 0) return;
    if (Date.now() < dbCooldownUntil) return; // retry after cooldown on next enqueue
    const batch = dbQueue.splice(0, dbQueue.length);
    try {
      const store = dbStoreOverride ?? ((await import('@/lib/db')).db as unknown as LegacyLogStore);
      dbStoreOverride = dbStoreOverride ?? store; // cache the shared client after first use
      for (const row of batch) {
        await store.log.create({ data: row });
      }
    } catch (err) {
      // Logging must never take the service down: cool down, warn ONCE.
      dbCooldownUntil = Date.now() + DB_COOLDOWN_MS;
      dbQueue.unshift(...batch.slice(-20)); // keep a tail for the retry
      if (dbQueue.length > DB_QUEUE_MAX) dbQueue.splice(0, dbQueue.length - DB_QUEUE_MAX);
      const now = Date.now();
      if (now - dbWarnedAt > DB_COOLDOWN_MS) {
        dbWarnedAt = now;
        try {
          process.stderr.write(`[NURAE] log DB sink unavailable for ${DB_COOLDOWN_MS / 1000}s: ${err instanceof Error ? err.message : String(err)}\n`);
        } catch { /* even stderr can fail — give up quietly */ }
      }
    }
  }

  // --- console sink ---------------------------------------------------------
  function echoConsole(entry: LogEntry): void {
    try {
      const scopeTag = entry.botId ? `bot:${entry.botId.slice(0, 8)}` : entry.domain;
      const head = `[${identityLine()}] [${LEVEL_PREFIX[entry.level]}] [${scopeTag}] ${entry.message}`;
      const extras: string[] = [];
      if (entry.event) extras.push(`event=${entry.event}`);
      if (entry.requestId) extras.push(`req=${entry.requestId}`);
      if (entry.durationMs !== undefined) extras.push(`${entry.durationMs}ms`);
      if (entry.data !== undefined) extras.push(stringifySafe(redactDeep(entry.data)));
      const line = extras.length ? `${head} · ${extras.join(' · ')}` : head;
      const withError = entry.error ? `${line}\n  ${entry.error.name}: ${entry.error.message}\n  ${entry.error.stack ?? ''}` : line;
      if (entry.level === 'error' || entry.level === 'fatal') console.error(withError);
      else if (entry.level === 'warn') console.warn(withError);
      else console.log(withError);
    } catch {
      /* console can be patched/broken — never propagate */
    }
  }

  // --- core write path ------------------------------------------------------
  function write(level: SuperLevel, input: LogInput, extraData?: unknown, childScope?: LogScope): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
    let entry: LogEntry;
    if (typeof input === 'string') {
      entry = {
        ts: new Date().toISOString(),
        level,
        domain: (childScope ?? scope).domain ?? 'core',
        message: truncateForLog(sanitizeForLog(input)),
        botId: (childScope ?? scope).botId ?? null,
        requestId: (childScope ?? scope).requestId,
        data: extraData !== undefined ? redactDeep(extraData) : undefined,
      };
    } else {
      const s = { ...scope, ...(childScope ?? {}) };
      entry = {
        ts: new Date().toISOString(),
        level,
        // Input fields win only when DEFINED — `?? undefined` spread would
        // erase an inherited child scope (requestId etc.).
        domain: input.domain ?? s.domain ?? 'core',
        message: truncateForLog(sanitizeForLog(input.message ?? '')),
        event: input.event,
        botId: input.botId ?? s.botId ?? null,
        requestId: input.requestId ?? s.requestId,
        durationMs: input.durationMs,
        data: input.data !== undefined ? redactDeep(input.data) : extraData !== undefined ? redactDeep(extraData) : undefined,
        error: normalizeError(input.error),
      };
    }
    try { ring.push(entry); if (ring.length > ringSize) ring.shift(); } catch { /* ring can't fail, belt and suspenders */ }
    if (consoleSink) echoConsole(entry);
    if (jsonlSink) writeJsonl(stringifySafe(entry));
    if (dbSink) enqueueDb(entry);
  }

  function normalizeError(err: unknown): LogError | undefined {
    if (err === null || err === undefined) return undefined;
    if (err instanceof Error) {
      return { name: err.name, message: err.message, stack: typeof err.stack === 'string' ? err.stack.slice(0, 4000) : undefined };
    }
    // Already-formatted LogError (e.g. from formatCrash) — pass through
    // instead of wrapping it AGAIN into UnknownError "[object Object]".
    if (typeof err === 'object' && typeof (err as LogError).name === 'string' && typeof (err as LogError).message === 'string') {
      return err as LogError;
    }
    return { name: 'UnknownError', message: String(err) };
  }

  function searchable(entry: LogEntry): string {
    return `${entry.domain} ${entry.event ?? ''} ${entry.message} ${entry.error ? `${entry.error.name} ${entry.error.message}` : ''} ${stringifySafe(entry.data ?? '')}`.toLowerCase();
  }

  const api = {
    debug: (input: LogInput, data?: unknown) => write('debug', input, data),
    info: (input: LogInput, data?: unknown) => write('info', input, data),
    warn: (input: LogInput, data?: unknown) => write('warn', input, data),
    error: (input: LogInput, data?: unknown) => write('error', input, data),
    fatal: (input: LogInput, data?: unknown) => write('fatal', input, data),
    child(childScope: LogScope): SuperLogger {
      const merged: LogScope = { ...scope, ...childScope };
      return createChild(merged);
    },
    recent(recentOpts?: { level?: SuperLevel; q?: string; limit?: number }): LogEntry[] {
      let list = ring;
      if (recentOpts?.level) {
        const min = LEVEL_ORDER[recentOpts.level];
        list = list.filter((e) => LEVEL_ORDER[e.level] >= min);
      }
      if (recentOpts?.q) {
        const q = recentOpts.q.toLowerCase();
        list = list.filter((e) => searchable(e).includes(q));
      }
      const limit = Math.max(1, Math.min(recentOpts?.limit ?? 200, 2000));
      return list.slice(-limit);
    },
    queryFileLogs(fileOpts?: { level?: SuperLevel; q?: string; limit?: number; maxBytes?: number }): LogEntry[] {
      try {
        if (!existsSync(/*turbopackIgnore: true*/ filePath)) return [];
        const maxBytes = Math.min(fileOpts?.maxBytes ?? 512 * 1024, 4 * 1024 * 1024);
        const size = statSync(/*turbopackIgnore: true*/ filePath).size;
        const start = Math.max(0, size - maxBytes);
        const raw = readFileSync(/*turbopackIgnore: true*/ filePath, 'utf8');
        const slice = start > 0 ? raw.slice(raw.indexOf('\n') + 1) : raw; // drop the partial first line
        const lines = slice.split('\n').filter((l) => l.trim().length > 0);
        let entries: LogEntry[] = [];
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line) as LogEntry;
            if (!parsed || typeof parsed !== 'object' || !parsed.level) continue;
            entries.push(parsed);
          } catch { /* skip malformed line — JSONL is append-only, partials possible */ }
        }
        if (fileOpts?.level) {
          const min = LEVEL_ORDER[fileOpts.level];
          entries = entries.filter((e) => LEVEL_ORDER[e.level] >= min);
        }
        if (fileOpts?.q) {
          const q = fileOpts.q.toLowerCase();
          entries = entries.filter((e) => searchable(e).includes(q));
        }
        const limit = Math.max(1, Math.min(fileOpts?.limit ?? 200, 2000));
        return entries.slice(-limit);
      } catch {
        return [];
      }
    },
    jsonlPath,
    health: (): LogSinkHealth => ({
      level: minLevel,
      jsonl: { enabled: jsonlSink && !jsonlDisabled, path: filePath, usingFallbackDir: jsonlFallback },
      db: { enabled: dbSink, degraded: Date.now() < dbCooldownUntil, queued: dbQueue.length },
      ring: { entries: ring.length, capacity: ringSize },
    }),
    flush: async () => { await drainDb(); },
    close: () => {
      if (jsonlFd !== null) {
        try { closeSync(jsonlFd); } catch { /* already closed */ }
        jsonlFd = null;
      }
      jsonlDisabled = true;
      dbQueue.length = 0;
    },
  } satisfies SuperLogger & { jsonlPath(): string };

  function createChild(mergedScope: LogScope): SuperLogger {
    return {
      debug: (input, data) => write('debug', input, data, mergedScope),
      info: (input, data) => write('info', input, data, mergedScope),
      warn: (input, data) => write('warn', input, data, mergedScope),
      error: (input, data) => write('error', input, data, mergedScope),
      fatal: (input, data) => write('fatal', input, data, mergedScope),
      child: (inner) => createChild({ ...mergedScope, ...inner }),
      recent: api.recent,
      queryFileLogs: api.queryFileLogs,
      jsonlPath,
      health: api.health,
      flush: api.flush,
      close: api.close,
    };
  }

  return api;
}

// ---------------------------------------------------------------------------
// Process-level crash capture (installed once per process)
// ---------------------------------------------------------------------------

interface CrashState {
  installed: boolean;
  logger: SuperLogger | null;
  rejectionHandler: ((err: unknown) => void) | null;
  exceptionHandler: ((err: Error) => void) | null;
}

// Same dual-instance protection as the logger singleton: without this, two
// module instances would each register crash listeners (double logs, double
// exit timers).
const globalForCrash = globalThis as unknown as { __nuraeCrashState?: CrashState };
const crashState: CrashState = globalForCrash.__nuraeCrashState ?? {
  installed: false,
  logger: null,
  rejectionHandler: null,
  exceptionHandler: null,
};
globalForCrash.__nuraeCrashState = crashState;

/** Pure formatter — exported for tests. */
export function formatCrash(err: unknown): LogError {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: typeof err.stack === 'string' ? err.stack.slice(0, 4000) : undefined };
  }
  return { name: 'UnknownError', message: String(err) };
}

/**
 * Install process-level capture: unhandledRejection + uncaughtException.
 * uncaughtException logs synchronously to file (crash must not lose its last
 * record), echoes to console (→ dev.log mirror), then exits(1) unless
 * NURAE_LOG_CRASH_EXIT=0 — preserving Node's crash semantics instead of
 * silently continuing from a corrupt state. Idempotent.
 */
export function installSuperLogger(instance?: SuperLogger): void {
  if (crashState.installed) return;
  crashState.installed = true;
  crashState.logger = instance ?? defaultLogger;

  crashState.rejectionHandler = (err: unknown) => {
    try {
      crashState.logger!.fatal({
        domain: 'process',
        event: 'UNHANDLED_REJECTION',
        message: 'Unhandled promise rejection captured',
        error: formatCrash(err),
      });
    } catch { /* never re-throw from a crash handler */ }
  };
  process.on('unhandledRejection', crashState.rejectionHandler);

  crashState.exceptionHandler = (err: Error) => {
    try {
      // FATAL, synchronously: ring + console + JSONL file are all synchronous
      // paths; the DB queue may not drain on exit — that loss is acceptable.
      crashState.logger!.fatal({
        domain: 'process',
        event: 'UNCAUGHT_EXCEPTION',
        message: 'Uncaught exception — process will exit',
        error: formatCrash(err),
      });
      crashState.logger!.flush().catch(() => undefined);
    } catch { /* never re-throw from a crash handler */ }
    if (process.env.NURAE_LOG_CRASH_EXIT !== '0') {
      // Small delay so the echo (stdout) and file append are flushed before
      // the process dies — crash semantics preserved, record preserved too.
      setTimeout(() => process.exit(1), 50).unref?.();
    }
  };
  process.on('uncaughtException', crashState.exceptionHandler);
}

/** Test escape hatch: drop listeners without closing sinks. */
export function uninstallSuperLogger(): void {
  if (!crashState.installed) return;
  if (crashState.rejectionHandler) process.off('unhandledRejection', crashState.rejectionHandler);
  if (crashState.exceptionHandler) process.off('uncaughtException', crashState.exceptionHandler);
  crashState.rejectionHandler = null;
  crashState.exceptionHandler = null;
  crashState.logger = null;
  crashState.installed = false;
}

// ---------------------------------------------------------------------------
// Default instance + legacy API (back-compat for existing imports)
// ---------------------------------------------------------------------------

// Next.js can load instrumentation and route handlers as SEPARATE module
// instances — two `new createSuperLogger()` here would mean two rings, two
// JSONL fds and two DB queues. Pin the singleton on globalThis (same pattern
// as the Prisma client in src/lib/db.ts) so every importer shares ONE logger.
const globalForLogger = globalThis as unknown as { __nuraeSuperLogger?: SuperLogger };

const defaultLogger: SuperLogger = globalForLogger.__nuraeSuperLogger ?? createSuperLogger();
globalForLogger.__nuraeSuperLogger = defaultLogger;

/** The platform-wide logger. Import this everywhere. */
export const logger: SuperLogger = defaultLogger;

export type LogLevel = 'info' | 'warn' | 'error';
export interface Logger {
  info(botId: string | null, message: string): Promise<void>;
  warn(botId: string | null, message: string): Promise<void>;
  error(botId: string | null, message: string): Promise<void>;
}

/**
 * LEGACY factory — preserved for existing callers. Builds a SuperLogger whose
 * only DB sink is the injected store (never the shared db client) and whose
 * console echo matches the original identity-line format.
 */
export function createLogger(store: LegacyLogStore, opts?: { silent?: boolean }): Logger {
  const scoped = createSuperLogger({
    dbStore: store,
    sinks: { console: !opts?.silent, jsonl: false, db: true },
  });
  return {
    info: (botId, message) => { scoped.info({ domain: 'core', botId, message }); return Promise.resolve(); },
    warn: (botId, message) => { scoped.warn({ domain: 'core', botId, message }); return Promise.resolve(); },
    error: (botId, message) => { scoped.error({ domain: 'core', botId, message }); return Promise.resolve(); },
  };
}

/** Request-id helper for API routes: one id per request, logged everywhere. */
export function newRequestId(): string {
  return randomUUID();
}

/** Boot marker — called from instrumentation after install. */
export function logBootLine(): void {
  logger.info({
    domain: 'boot',
    event: 'BOOT',
    message: `NURAE ${NURAE_VERSION} super logger online · node ${process.version} · ${process.platform} ${process.arch} · pid ${process.pid}`,
  });
}
