import './helpers';
/**
 * NURAE — data-home resolution lock (user-facing contract).
 *
 * "Make sure the db goes to AppData\Local — not prisma/, not Roaming."
 * These tests pin the exact Windows data-home chain so it can never drift
 * back to %APPDATA% (Roaming) or to a schema-relative path:
 *   1. NURAE_DATA_DIR overrides everything, on any OS,
 *   2. win32 → %LOCALAPPDATA%\FRAZIYM\NURAE — even when APPDATA is set,
 *   3. win32 without LOCALAPPDATA → homedir\AppData\Local\FRAZIYM\NURAE,
 *   4. non-Windows → the app root (NURAE_APP_ROOT, then cwd),
 *   5. relative file: DATABASE_URLs resolve against the DATA ROOT — this is
 *      what stops the prisma CLI path from forking a database into prisma/db.
 */

import { describe, expect, test, afterEach } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dataRoot, databaseUrl, resolveDataPath } from '../../src/lib/paths';

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined) {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function fakePlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const key of Object.keys(savedEnv)) delete savedEnv[key];
  Object.defineProperty(process, 'platform', realPlatform);
});

describe('data home resolution (Windows → AppData\\Local)', () => {
  test('NURAE_DATA_DIR overrides everything, on any OS', () => {
    setEnv('NURAE_DATA_DIR', '/custom/data/home');
    expect(dataRoot()).toBe('/custom/data/home');
    fakePlatform('win32');
    expect(dataRoot()).toBe('/custom/data/home');
  });

  test('win32 → %LOCALAPPDATA%\\FRAZIYM\\NURAE — APPDATA (Roaming) is ignored', () => {
    fakePlatform('win32');
    setEnv('NURAE_DATA_DIR', undefined);
    setEnv('LOCALAPPDATA', 'C:\\Users\\you\\AppData\\Local');
    setEnv('APPDATA', 'C:\\Users\\you\\AppData\\Roaming');
    const root = dataRoot();
    expect(root).toBe(join('C:\\Users\\you\\AppData\\Local', 'FRAZIYM', 'NURAE'));
    expect(root).not.toContain('Roaming');
  });

  test('win32 without LOCALAPPDATA falls back to homedir\\AppData\\Local', () => {
    fakePlatform('win32');
    setEnv('NURAE_DATA_DIR', undefined);
    setEnv('LOCALAPPDATA', undefined);
    const root = dataRoot();
    expect(root.startsWith(homedir())).toBe(true);
    expect(root.endsWith(join('AppData', 'Local', 'FRAZIYM', 'NURAE'))).toBe(true);
  });

  test('non-Windows resolves to the app root (NURAE_APP_ROOT, then cwd)', () => {
    fakePlatform('linux');
    setEnv('NURAE_DATA_DIR', undefined);
    setEnv('NURAE_APP_ROOT', '/srv/nurae');
    expect(dataRoot()).toBe('/srv/nurae');
    setEnv('NURAE_APP_ROOT', undefined);
    expect(dataRoot()).toBe(process.cwd());
  });

  test('relative file: DATABASE_URL resolves against the data root, not the schema dir', () => {
    // The chain under test (relative URL → data root) is platform-independent;
    // NURAE_DATA_DIR feeds it the same string the win32 branch produces above.
    // (A windows-style path string can't be used here: the Linux runner's
    // posix resolve() treats drive letters as relative — a simulation
    // artifact, not product behavior. Real Windows gets win32 resolve().)
    setEnv('NURAE_DATA_DIR', '/mock/data/home');
    setEnv('DATABASE_URL', 'file:./db/nurae.db');
    expect(databaseUrl()).toBe('file:/mock/data/home/db/nurae.db');
  });

  test('absolute file:, :memory: and non-file URLs pass through untouched', () => {
    setEnv('NURAE_DATA_DIR', undefined);
    setEnv('DATABASE_URL', 'file:/abs/path/nurae.db');
    expect(databaseUrl()).toBe('file:/abs/path/nurae.db');
    setEnv('DATABASE_URL', 'file::memory:');
    expect(databaseUrl()).toBe('file::memory:');
    setEnv('DATABASE_URL', 'libsql://nurae.example.io');
    expect(databaseUrl()).toBe('libsql://nurae.example.io');
  });

  test('resolveDataPath: absolute passes through, relative anchors to the data root', () => {
    setEnv('NURAE_DATA_DIR', '/custom/data/home');
    expect(resolveDataPath('/abs/file.bin')).toBe('/abs/file.bin');
    expect(resolveDataPath('db/uploads')).toBe('/custom/data/home/db/uploads');
  });
});
