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
 *   %APPDATA%\FRAZIYM\NURAE
 * — the per-user application-data home, like every native Windows app. A
 * project folder can be wiped by a fresh clone/build without losing data.
 * NURAE_DATA_DIR overrides the whole chain on any OS.
 */

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
 *   2. Windows: %APPDATA%\FRAZIYM\NURAE — the app's real data home.
 *   3. Everywhere else: the project root (Linux servers, dev, CI).
 */
export function dataRoot(): string {
  const configured = process.env.NURAE_DATA_DIR?.trim();
  if (configured) return configured;
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim();
    if (appData) return join(appData, 'FRAZIYM', 'NURAE');
  }
  return appRoot();
}

/** Resolve a filesystem path against the data root (absolute passes through). */
export function resolveDataPath(p: string): string {
  return isAbsolute(p) ? p : resolve(dataRoot(), p);
}

/**
 * The libSQL database URL with relative `file:` paths made absolute against
 * the project root. Non-file URLs (libsql://, :memory:) pass through.
 */
export function databaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim() || 'file:./db/custom.db';
  if (!url.startsWith('file:')) return url;
  const path = url.slice('file:'.length);
  if (!path || path.startsWith(':')) return url; // ":memory:" and friends
  return 'file:' + resolveDataPath(path);
}
