#!/usr/bin/env node
/**
 * NURAE — postbuild: prepare `.next/standalone` for production.
 *
 * Replaces the Unix-only `cp -r … && rm -rf …` tail of the old build script
 * (it broke on Windows PowerShell: 'cp' is not recognized). Pure node:fs,
 * so `npm run build` behaves identically on Windows, macOS and Linux.
 *
 * Steps:
 *   1. copy `.next/static`  → `.next/standalone/.next/static` (the standalone
 *      server does not bundle client assets by itself),
 *   2. copy `public`        → `.next/standalone/public`,
 *   3. strip project-root artifacts that must NEVER leak into the deploy
 *      bundle: the dev database, uploads, `.env` (secrets!) and log files.
 */

import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const standalone = resolve(root, '.next/standalone');

if (!existsSync(resolve(standalone, 'server.js'))) {
  console.error('[NURAE] postbuild: .next/standalone/server.js not found — did `next build` succeed?');
  process.exit(1);
}

// 1+2. Client assets into the standalone bundle.
cpSync(resolve(root, '.next/static'), resolve(standalone, '.next/static'), { recursive: true });
if (existsSync(resolve(root, 'public'))) {
  cpSync(resolve(root, 'public'), resolve(standalone, 'public'), { recursive: true });
}

// 3. Data + secrets stay OUTSIDE the build output (the launcher pins
// NURAE_APP_ROOT to the project root, so the app reads them from there).
for (const name of ['db', 'upload', '.env', 'dev.log', 'server.log']) {
  rmSync(resolve(standalone, name), { recursive: true, force: true });
}

console.log('[NURAE] postbuild: standalone bundle ready (static + public copied, data/secrets excluded)');
