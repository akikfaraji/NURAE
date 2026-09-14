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
 * The rule: relative data paths always resolve against the PROJECT ROOT.
 * The root is pinned, in order, by:
 *   1. NURAE_APP_ROOT — set explicitly by scripts/start-prod.mjs (the
 *      supported production launcher; absolute → chdir-immune).
 *   2. The standalone marker — the standalone server.js sets
 *      __NEXT_PRIVATE_STANDALONE_CONFIG before app code runs and its cwd is
 *      `<root>/.next/standalone`, so the root is exactly two levels up.
 *   3. process.cwd() — dev (`next dev`), tests, scripts (already the root).
 */

import { isAbsolute, resolve } from 'node:path';

export function appRoot(): string {
  const configured = process.env.NURAE_APP_ROOT?.trim();
  if (configured) return configured;
  if (process.env.__NEXT_PRIVATE_STANDALONE_CONFIG) {
    return resolve(process.cwd(), '..', '..');
  }
  return process.cwd();
}

/** Resolve a filesystem path against the project root (absolute passes through). */
export function resolveDataPath(p: string): string {
  return isAbsolute(p) ? p : resolve(appRoot(), p);
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
