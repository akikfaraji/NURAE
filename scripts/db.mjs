#!/usr/bin/env node
/**
 * NURAE — Prisma CLI wrapper: points every `npm run db:*` command at the
 * app's REAL database (the data home), not at a path derived from
 * prisma/schema.prisma.
 *
 * Why this exists: the prisma CLI resolves RELATIVE `file:` URLs against the
 * schema file's directory (prisma/). With the Windows data home
 * (%APPDATA%\FRAZIYM\NURAE — src/lib/paths.ts dataRoot()), a plain
 * `npm run db:push` silently created prisma\db\nurae.db while the app read
 * <data home>\db\nurae.db — two databases, zero errors.
 *
 * This wrapper mirrors the app's resolution chain (src/lib/paths.ts +
 * scripts/start-prod.mjs):
 *   1. load .env from the project root (real env vars always win),
 *   2. resolve a relative `file:` URL against the data root:
 *        NURAE_DATA_DIR  →  %APPDATA%\FRAZIYM\NURAE (win32)  →  project root,
 *   3. pre-create the database directory,
 *   4. hand the CLI an absolute, forward-slash DATABASE_URL (file:C:/… is the
 *      canonical Windows form; raw backslashes break prisma's URL parsing)
 *      and spawn the CLI with stdio inherited (interactive prompts work).
 *
 * Non-file URLs (libsql://, :memory:) and absolute paths pass through.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// --- 1. Load .env from the project root (real env vars always win) ---------
const envPath = resolve(root, '.env');
if (existsSync(envPath)) {
  for (const rawLine of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

// --- 2. Mirror the app's dataRoot() chain ----------------------------------
const appRoot = process.env.NURAE_APP_ROOT?.trim() || root;
function dataRoot() {
  const configured = process.env.NURAE_DATA_DIR?.trim();
  if (configured) return configured;
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim();
    if (appData) return join(appData, 'FRAZIYM', 'NURAE');
  }
  return appRoot;
}

// --- 3. Make the database URL absolute + create its directory --------------
let dbUrl = process.env.DATABASE_URL?.trim() || 'file:./db/custom.db';
if (dbUrl.startsWith('file:')) {
  const path = dbUrl.slice('file:'.length);
  if (path && !path.startsWith(':')) {
    const abs = (isAbsolute(path) ? path : resolve(dataRoot(), path)).replace(/\\/g, '/');
    try {
      mkdirSync(dirname(abs), { recursive: true });
    } catch {
      /* let the CLI surface filesystem problems */
    }
    dbUrl = 'file:' + abs;
  }
}
process.env.DATABASE_URL = dbUrl;

// --- 4. Run the local prisma CLI against the resolved database -------------
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('[NURAE] usage: node scripts/db.mjs <prisma args…>  (e.g. `db push`)');
  process.exit(2);
}
const cli = resolve(root, 'node_modules', 'prisma', 'build', 'index.js');
if (!existsSync(cli)) {
  console.error('[NURAE] prisma CLI not found — run `npm install` first.');
  process.exit(1);
}

console.log(`[NURAE] prisma ${args.join(' ')}`);
console.log(`[NURAE] database: ${dbUrl}`);

const result = spawnSync(process.execPath, [cli, ...args], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});
process.exit(result.status ?? 1);
