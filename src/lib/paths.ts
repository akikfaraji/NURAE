/**
 * NURAE — application path resolution.
 *
 * ONE definition of "where does NURAE keep its data". This exists because the
 * production server (`output: "standalone"`) is booted from
 * `.next/standalone/server.js`, which does `process.chdir(__dirname)` — so
 * `process.cwd()` inside production points at `.next/standalone`, NOT at the
 * project root. Any relative path (the default `file:./db/custom.db`, the
 * auto-generated secret key file, the uploads folder) would silently resolve
 * INSIDE the build output: a fresh database fork on every machine, a stale
 * build-time snapshot, a different secret key — "works in dev, dead in
 * production" with no visible error.
 *
 * The rule: relative data paths always resolve against the DATA ROOT, which
 * defaults to the project root. The root is pinned, in order, by:
 *   1. NURAE_APP_ROOT — set explicitly by scripts/start-prod.mjs (the
 *      supported production launcher; absolute → chdir-immune).
 *   2. The standalone marker — the standalone server.js sets
 *      __NEXT_PRIVATE_STANDALONE_CONFIG before app code runs and its cwd is
 *      `<root>/.next/standalone`, so the root is exactly two levels up.
 *   3. process.cwd() — dev (`next dev`), tests, scripts (already the root).
 *
 * On Windows the DATA ROOT is deliberately NOT the project folder: installs
 * keep mutable state (database, secret key, uploads) under
 *   %LOCALAPPDATA%\FRAZIYM\NURAE
 * — the per-user MACHINE-LOCAL application-data home (AppData\Local, not
 * Roaming: a database/cache is machine-specific and must not follow a
 * roaming profile). A project folder can be wiped by a fresh clone/build
 * without losing data. NURAE_DATA_DIR overrides the whole chain on any OS.
 */

import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export function appRoot(): string {
  const configured = process.env.NURAE_APP_ROOT?.trim();
  if (configured) return configured;
  if (process.env.__NEXT_PRIVATE_STANDALONE_CONFIG) {
    return resolve(process.cwd(), '..', '..');
  }
  return process.cwd();
}

/**
 * Where NURAE keeps MUTABLE data (db, secret key, uploads).
 *   1. NURAE_DATA_DIR — explicit override, wins on every OS.
 *   2. Windows: %LOCALAPPDATA%\FRAZIYM\NURAE — the app's real data home
 *      (machine-local AppData\Local, NOT Roaming).
 *   3. Everywhere else: the project root (Linux servers, dev, CI).
 */
export function dataRoot(): string {
  const configured = process.env.NURAE_DATA_DIR?.trim();
  if (configured) return configured;
  if (process.platform === 'win32') {
    const localAppData =
      process.env.LOCALAPPDATA?.trim() || join(homedir(), 'AppData', 'Local');
    return join(localAppData, 'FRAZIYM', 'NURAE');
  }
  return appRoot();
}

/** Resolve a filesystem path against the data root (absolute passes through). */
export function resolveDataPath(p: string): string {
  return isAbsolute(p) ? p : resolve(dataRoot(), p);
}

/**
 * Windows env-var references (%APPDATA%, %LOCALAPPDATA%, …) are cmd.exe
 * syntax — Node NEVER expands them, and in a URL the bare '%' starts percent
 * encoding, so libSQL dies with the cryptic
 *   URL_INVALID: URL component has invalid percent encoding: URIError: URI malformed
 * on every single query. Worse, the resolution chain treats the un-expanded
 * path as RELATIVE and happily creates a junk database in a folder literally
 * named "%APPDATA%" under the data home (scripts/db.mjs, boot schema sync).
 *
 * This guard turns all of that into ONE actionable error at the single place
 * the database URL is built. Legit percent-escapes (%20 for spaces) pass.
 */
export function assertNoWindowsEnvLiteral(url: string): void {
  if (!url.startsWith('file:') || !url.includes('%')) return;
  if (!/%(?![0-9A-Fa-f]{2})/.test(url)) return; // every % starts a valid escape
  const envRef = /%[A-Za-z_][A-Za-z0-9_]*%/.test(url);
  throw new Error(
    envRef
      ? '[NURAE] DATABASE_URL uses a Windows env-var reference like %APPDATA% — Node and ' +
        'libSQL cannot expand %VAR% (the bare % breaks URL percent-decoding, which surfaces ' +
        'as "URL_INVALID: URI malformed" on every query). FIX: delete the DATABASE_URL line ' +
        'from .env — NURAE then places the database in the Windows data home automatically ' +
        '(%LOCALAPPDATA%\\FRAZIYM\\NURAE\\db\\custom.db), or set an absolute path with ' +
        'forward slashes (DATABASE_URL=file:C:/path/to/custom.db). Got: ' +
        url
      : `[NURAE] DATABASE_URL contains a bare % that is not a valid percent-escape ` +
          `(use %20 for spaces): ${url}`,
  );
}

/**
 * The libSQL database URL with relative `file:` paths made absolute against
 * the project root. Non-file URLs (libsql://, :memory:) pass through.
 *
 * Guarded (assertNoWindowsEnvLiteral) and normalized to forward slashes —
 * `file:C:/…` is the canonical Windows form for libSQL/prisma file: URLs
 * (raw backslashes break the prisma CLI's URL parsing; scripts/db.mjs and
 * the boot schema sync already spoke this dialect, now the app does too).
 */
export function databaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim() || 'file:./db/custom.db';
  assertNoWindowsEnvLiteral(url);
  if (!url.startsWith('file:')) return url;
  const path = url.slice('file:'.length);
  if (!path || path.startsWith(':')) return url; // ":memory:" and friends
  return 'file:' + resolveDataPath(path).replace(/\\/g, '/');
}
