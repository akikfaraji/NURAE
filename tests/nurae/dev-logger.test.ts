/**
 * NURAE — dev.log error capture tests.
 *
 * The owner runs the site on Windows where the terminal closes: "what broke?"
 * must be answerable from the filesystem alone. These tests pin the contract:
 * every console.error/warn + unhandled rejections land in <dataRoot>/logs/dev.log,
 * the logger is idempotent, fails quiet, and opts out cleanly.
 */

import './helpers';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpRoots: string[] = [];
let uninstall: (() => void) | null = null;

function freshDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nurae-devlog-'));
  tmpRoots.push(dir);
  return dir;
}

beforeEach(() => {
  process.env.NURAE_DEV_LOG = '1'; // vitest default is off — force on for these tests
});

afterAll(() => {
  uninstall?.();
  delete process.env.NURAE_DEV_LOG;
  for (const dir of tmpRoots) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

async function freshLogger(dataDir: string) {
  process.env.NURAE_DATA_DIR = dataDir;
  const mod = await import('../../src/lib/nurae/startup/dev-logger');
  // Fresh module state per data dir (the real server installs once per process).
  const { vi } = await import('vitest');
  vi.resetModules();
  const fresh = await import('../../src/lib/nurae/startup/dev-logger');
  uninstall = fresh.uninstallDevLogger;
  return fresh;
}

describe('dev.log error capture', () => {
  test('console.error and console.warn are appended with timestamps', async () => {
    const dataDir = freshDataDir();
    const logger = await freshLogger(dataDir);
    logger.installDevLogger();

    console.error('DB query failed', { code: 'P2002' });
    console.warn('deprecation: something');
    logger.uninstallDevLogger();
    uninstall = null;

    const log = readFileSync(join(dataDir, 'logs', 'dev.log'), 'utf8');
    expect(log).toContain('[error] DB query failed { code: '); // util.inspect format
    expect(log).toContain("code: 'P2002'");
    expect(log).toContain('[warn] deprecation: something');
    expect(log).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(log).toContain('[boot] NURAE'); // boot header names the version
  });

  test('output still reaches the real console (tee, not capture)', async () => {
    const dataDir = freshDataDir();
    const logger = await freshLogger(dataDir);
    const seen: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => seen.push(args.join(' '));
    logger.installDevLogger();

    console.error('visible-in-terminal');
    logger.uninstallDevLogger();
    console.error = orig;
    uninstall = null;

    expect(seen.join('\n')).toContain('visible-in-terminal');
    expect(readFileSync(join(dataDir, 'logs', 'dev.log'), 'utf8')).toContain('visible-in-terminal');
  });

  test('unhandled promise rejections are captured', async () => {
    const dataDir = freshDataDir();
    const logger = await freshLogger(dataDir);
    logger.installDevLogger();

    // Emit the event directly (a real rejection would trip vitest's own handler).
    const boom = new Error('unhandled-rejection-marker');
    process.emit('unhandledRejection', boom, Promise.resolve());
    logger.uninstallDevLogger();
    uninstall = null;

    const log = readFileSync(join(dataDir, 'logs', 'dev.log'), 'utf8');
    expect(log).toContain('[unhandledRejection]');
    expect(log).toContain('unhandled-rejection-marker');
  });

  test('installing twice does not double-write (idempotent)', async () => {
    const dataDir = freshDataDir();
    const logger = await freshLogger(dataDir);
    logger.installDevLogger();
    logger.installDevLogger();

    console.error('once-only');
    logger.uninstallDevLogger();
    uninstall = null;

    const lines = readFileSync(join(dataDir, 'logs', 'dev.log'), 'utf8')
      .split('\n')
      .filter((l) => l.includes('once-only'));
    expect(lines).toHaveLength(1);
  });

  test('NURAE_DEV_LOG=0 disables capture entirely', async () => {
    const dataDir = freshDataDir();
    process.env.NURAE_DEV_LOG = '0';
    const logger = await freshLogger(dataDir);
    logger.installDevLogger();

    console.error('should-not-appear');
    logger.uninstallDevLogger();
    uninstall = null;

    expect(existsSync(join(dataDir, 'logs', 'dev.log'))).toBe(false);
  });

  test('unreadable data dir fails quiet (no throw, console still works)', async () => {
    const badDir = join(freshDataDir(), 'file-not-dir');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(badDir, 'occupies the path so mkdir fails');
    const logger = await freshLogger(badDir);

    expect(() => logger.installDevLogger()).not.toThrow();
    expect(() => console.error('no-crash-please')).not.toThrow();
    logger.uninstallDevLogger();
    uninstall = null;
  });
});
