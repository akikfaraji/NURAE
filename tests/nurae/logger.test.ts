/**
 * NURAE — Super Logger test battery.
 * Covers: level filtering, deep redaction, ring buffer, child scoping, JSONL
 * sink + rotation, DB sink (injected store, failure cooldown), legacy compat,
 * crash formatting, and the never-throw guarantee on exotic inputs.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSuperLogger,
  createLogger,
  redactDeep,
  stringifySafe,
  formatCrash,
  installSuperLogger,
  uninstallSuperLogger,
  type LogEntry,
  type LegacyLogStore,
} from '../../src/lib/nurae/logging';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'nurae-logger-'));
}

/** A store recorder that can be told to fail (simulates DB down). */
function makeStore(fail = false): LegacyLogStore & { rows: { botId: string | null; level: string; event?: string; message: string }[] } {
  const rows: { botId: string | null; level: string; event?: string; message: string }[] = [];
  return {
    rows,
    log: {
      async create(args: { data: { botId: string | null; level: string; event?: string; message: string } }) {
        if (fail) throw new Error('db down');
        rows.push(args.data);
        return {};
      },
    },
  };
}

function drain(): Promise<void> {
  return new Promise((r) => setTimeout(r, 120));
}

afterEach(() => {
  uninstallSuperLogger();
});

// ---------------------------------------------------------------------------
describe('level filtering', () => {
  it('suppresses entries below the minimum level', () => {
    const log = createSuperLogger({ level: 'warn', sinks: { console: false, jsonl: false, db: false } });
    log.debug({ domain: 't', message: 'nope' });
    log.info({ domain: 't', message: 'nope either' });
    log.warn({ domain: 't', message: 'kept' });
    log.error({ domain: 't', message: 'kept too' });
    expect(log.recent().map((e) => e.message)).toEqual(['kept', 'kept too']);
  });

  it('NURAE_LOG_LEVEL=debug admits debug entries', () => {
    process.env.NURAE_LOG_LEVEL = 'debug';
    try {
      const log = createSuperLogger({ sinks: { console: false, jsonl: false, db: false } });
      log.debug({ domain: 't', message: 'fine-grained' });
      expect(log.recent().some((e) => e.message === 'fine-grained')).toBe(true);
    } finally {
      delete process.env.NURAE_LOG_LEVEL;
    }
  });
});

// ---------------------------------------------------------------------------
describe('deep redaction', () => {
  it('redacts secret-ish keys, keeps the rest', () => {
    const out = redactDeep({
      username: 'sam',
      password: 'hunter2',
      apiKey: 'sk-or-v1-abc',
      Authorization: 'Bearer xyz',
      nested: { botToken: '123:AA', note: 'safe' },
    }) as Record<string, unknown>;
    expect(out.username).toBe('sam');
    expect(out.password).toBe('[redacted]');
    expect(out.apiKey).toBe('[redacted]');
    expect(out.Authorization).toBe('[redacted]');
    expect((out.nested as Record<string, unknown>).botToken).toBe('[redacted]');
    expect((out.nested as Record<string, unknown>).note).toBe('safe');
  });

  it('survives circular structures, BigInt, throwing getters, and Errors', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    const getter = { get boom(): string { throw new Error('nope'); } };
    expect(() => stringifySafe({ a, big: 10n, getter })).not.toThrow();
    expect(redactDeep(10n)).toBe(10n);
    expect(redactDeep(new Error('e'))).toMatchObject({ name: 'Error', message: 'e' });
  });
});

// ---------------------------------------------------------------------------
describe('ring buffer', () => {
  it('caps capacity and filters by level + substring', () => {
    const log = createSuperLogger({ ringSize: 5, sinks: { console: false, jsonl: false, db: false } });
    for (let i = 0; i < 10; i++) log.info({ domain: 't', message: `tick ${i}` });
    log.warn({ domain: 't', message: 'warn item', event: 'W_EVT' });
    expect(log.recent()).toHaveLength(5);
    expect(log.recent()[0].message).toBe('tick 6'); // oldest evicted (10 ticks + 1 warn)
    expect(log.recent({ level: 'warn' }).map((e) => e.message)).toEqual(['warn item']);
    expect(log.recent({ q: 'tick 9' })).toHaveLength(1);
    expect(log.recent({ q: 'W_EVT' })[0]?.event).toBe('W_EVT');
  });
});

// ---------------------------------------------------------------------------
describe('child scoping', () => {
  it('inherits and merges domain/botId/requestId', () => {
    const log = createSuperLogger({ sinks: { console: false, jsonl: false, db: false } });
    const req = log.child({ requestId: 'req-1' });
    const bot = req.child({ domain: 'bot', botId: 'bot-77' });
    req.info({ domain: 'api', message: 'a' });
    bot.info('shorthand message');
    bot.error({ message: 'with event', event: 'BOT_X' });
    const es = log.recent() as LogEntry[];
    const a = es.find((e) => e.message === 'a')!;
    expect(a.domain).toBe('api');
    expect(a.requestId).toBe('req-1');
    const b = es.find((e) => e.message === 'shorthand message')!;
    expect(b.domain).toBe('bot');
    expect(b.botId).toBe('bot-77');
    expect(b.requestId).toBe('req-1');
    expect(es.find((e) => e.event === 'BOT_X')!.botId).toBe('bot-77');
  });
});

// ---------------------------------------------------------------------------
describe('JSONL sink', () => {
  it('writes parseable structured lines', async () => {
    const dir = tmpDir();
    try {
      const log = createSuperLogger({ dir, sinks: { console: false, db: false }, dbStore: makeStore() });
      log.info({ domain: 'api', message: 'hello jsonl', data: { ok: true }, requestId: 'r1' });
      log.close();
      const file = join(dir, 'nurae.jsonl');
      expect(existsSync(file)).toBe(true);
      const lines = readFileSync(file, 'utf8').trim().split('\n');
      const parsed = JSON.parse(lines[0]);
      expect(parsed.level).toBe('info');
      expect(parsed.domain).toBe('api');
      expect(parsed.message).toBe('hello jsonl');
      expect(parsed.data.ok).toBe(true);
      expect(parsed.requestId).toBe('r1');
      expect(typeof parsed.ts).toBe('string');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rotates at rotateBytes keeping N generations', () => {
    const dir = tmpDir();
    try {
      const log = createSuperLogger({ dir, rotateBytes: 64 * 1024, keepGenerations: 2, sinks: { console: false, db: false } });
      const filler = 'x'.repeat(4000);
      for (let i = 0; i < 40; i++) log.info({ domain: 't', message: filler });
      log.close();
      const files = readdirSync(dir).sort();
      expect(files).toContain('nurae.jsonl');
      expect(files.some((f) => f === 'nurae.jsonl.1' || f === 'nurae.jsonl.2')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
describe('DB sink', () => {
  it('queues entries with event code and DB level mapping', async () => {
    const store = makeStore();
    const log = createSuperLogger({ dbStore: store, sinks: { console: false, jsonl: false } });
    log.info({ domain: 'api', event: 'USER_LOGIN', message: 'in', botId: null });
    log.fatal({ domain: 'proc', message: 'fatal maps to error' });
    await drain();
    expect(store.rows).toHaveLength(2);
    expect(store.rows[0]).toMatchObject({ level: 'info', event: 'USER_LOGIN' });
    expect(store.rows[1]).toMatchObject({ level: 'error', event: 'PROC_FATAL' });
    log.close();
  });

  it('never throws when the store fails and cools down', async () => {
    const store = makeStore(true);
    const log = createSuperLogger({ dbStore: store, sinks: { console: false, jsonl: false } });
    expect(() => log.error({ domain: 't', message: 'boom path' })).not.toThrow();
    await drain();
    // Second burst during cooldown is silently retained, no crash:
    expect(() => log.error({ domain: 't', message: 'still fine' })).not.toThrow();
    await log.flush();
    log.close();
    expect(store.rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('legacy createLogger compat', () => {
  it('writes through the injected store and honors silent', async () => {
    const store = makeStore();
    const log = createLogger(store, { silent: true });
    await log.warn(null, 'legacy warn');
    await log.error('bot123456789', 'legacy error');
    await drain();
    expect(store.rows).toHaveLength(2);
    expect(store.rows[0]).toMatchObject({ botId: null, level: 'warn' });
    expect(store.rows[1].botId).toBe('bot123456789');
  });
});

// ---------------------------------------------------------------------------
describe('crash capture', () => {
  it('formatCrash normalizes Errors and raw values', () => {
    expect(formatCrash(new TypeError('bad'))).toMatchObject({ name: 'TypeError', message: 'bad' });
    expect(formatCrash('raw string')).toEqual({ name: 'UnknownError', message: 'raw string' });
  });

  it('install registers process listeners; uninstall removes them', () => {
    const before = process.listenerCount('unhandledRejection');
    installSuperLogger(createSuperLogger({ sinks: { console: false, jsonl: false, db: false } }));
    expect(process.listenerCount('unhandledRejection')).toBeGreaterThan(before);
    expect(process.listenerCount('uncaughtException')).toBeGreaterThan(0);
    uninstallSuperLogger();
    expect(process.listenerCount('unhandledRejection')).toBe(before);
  });

  it('records an emitted unhandledRejection into the ring', () => {
    const log = createSuperLogger({ sinks: { console: false, jsonl: false, db: false } });
    installSuperLogger(log);
    process.emit('unhandledRejection', new Error('rejected!'), Promise.resolve());
    const hit = log.recent({ q: 'rejected!' });
    expect(hit).toHaveLength(1);
    expect(hit[0].event).toBe('UNHANDLED_REJECTION');
    expect(hit[0].error?.message).toBe('rejected!');
  });
});

// ---------------------------------------------------------------------------
describe('never-throw guarantee', () => {
  it('tolerates hostile inputs at every call site', () => {
    const log = createSuperLogger({ sinks: { console: false, jsonl: false, db: false } });
    const hostile = { get data(): string { throw new Error('getter'); } };
    expect(() => log.info({ domain: 't', message: '' })).not.toThrow();
    expect(() => log.error({ domain: 't', message: 'x', data: hostile })).not.toThrow();
    expect(() => log.error({ domain: 't', message: 'x', error: { name: 'n', message: 'm' } })).not.toThrow();
    expect(() => log.warn(Symbol('sym') as unknown as string)).not.toThrow();
    expect(() => log.info(12345 as unknown as string)).not.toThrow();
  });
});
