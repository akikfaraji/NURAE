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
import { join, resolve } from 'node:path';
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
    // The chain under test (relative URL → data root) is platform-independent,
    // but the RESULT is host-native: resolveDataPath() uses the host's resolve(),
    // so a POSIX-shaped NURAE_DATA_DIR becomes drive-anchored on Windows
    // (C:/mock/data/home) and stays as-is on POSIX. Expected value is computed
    // the same way the product does it, then canonicalised to forward slashes —
    // that canonical form is exactly what databaseUrl() must return.
    const mockHome = resolve('/mock/data/home').replace(/\\/g, '/');
    setEnv('NURAE_DATA_DIR', '/mock/data/home');
    setEnv('DATABASE_URL', 'file:./db/nurae.db');
    expect(databaseUrl()).toBe(`file:${mockHome}/db/nurae.db`);
    expect(databaseUrl()).not.toMatch(/\\/);
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
    // resolveDataPath returns the host-native spelling (not a URL), so the
    // expected value is built with this host's join/resolve.
    expect(resolveDataPath('db/uploads')).toBe(join(resolve('/custom/data/home'), 'db', 'uploads'));
  });
});

describe('DATABASE_URL guard (%VAR% Windows references fail with an actionable error)', () => {
  test('a restored %APPDATA% DATABASE_URL fails LOUDLY instead of URL_INVALID spam', () => {
    // The exact incident: .env restored from an old commit with
    // DATABASE_URL=file:%APPDATA%/... — libSQL answered URL_INVALID: URI
    // malformed on every query, and the resolution chain created a junk
    // database in a literally-named "%APPDATA%" folder. This must throw
    // BEFORE any socket/mkdir, telling the user exactly what to do.
    fakePlatform('win32');
    setEnv('NURAE_DATA_DIR', 'C:\\Users\\you\\AppData\\Local\\FRAZIYM\\NURAE');
    setEnv('DATABASE_URL', 'file:%APPDATA%/FRAZIYM/NURAE/db/custom.db');
    expect(() => databaseUrl()).toThrow(/%APPDATA%[\s\S]*delete the DATABASE_URL line/i);
    setEnv('DATABASE_URL', 'file:%LOCALAPPDATA%\\FRAZIYM\\NURAE\\db\\custom.db');
    expect(() => databaseUrl()).toThrow(/Windows env-var reference/);
  });

  test('a bare invalid % fails with the generic percent-escape message', () => {
    setEnv('NURAE_DATA_DIR', '/mock/data/home');
    setEnv('DATABASE_URL', 'file:./db/100%.db');
    expect(() => databaseUrl()).toThrow(/bare % that is not a valid percent-escape/);
  });

  test('legit percent-escapes (%20 for spaces) still pass', () => {
    setEnv('NURAE_DATA_DIR', '/mock/data/home');
    setEnv('DATABASE_URL', 'file:/abs/My%20Files/nurae.db');
    expect(databaseUrl()).toBe('file:/abs/My%20Files/nurae.db');
    setEnv('DATABASE_URL', 'file:./db/nurae%20copy.db');
    // Percent-escapes survive resolution untouched; only the prefix is rebased.
    expect(databaseUrl()).toBe(`file:${resolve('/mock/data/home').replace(/\\/g, '/')}/db/nurae%20copy.db`);
  });

  test('the returned URL is forward-slashed (canonical file: form for libSQL/prisma)', () => {
    // The win32 path resolution itself cannot run on a posix runner (path
    // module is bound at import), but the normalization is a plain string
    // replace — a backslash anywhere in the resolved segment must become /.
    setEnv('NURAE_DATA_DIR', '/mock/data/home');
    // Normalization is a plain string replace: a backslash anywhere in the
    // resolved segment must become /. The value is rebased on the host-native
    // data root (win32 → C:/mock/data/home), then asserted to carry no
    // backslash at all — that canonicalisation is the product guarantee.
    setEnv('DATABASE_URL', 'file:db\\custom.db');
    const url = databaseUrl();
    expect(url).toBe(`file:${resolve('/mock/data/home').replace(/\\/g, '/')}/db/custom.db`);
    expect(url).not.toMatch(/\\/);
  });
});
