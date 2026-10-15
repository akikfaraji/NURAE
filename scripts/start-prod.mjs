#!/usr/bin/env node
/**
 * NURAE — production launcher (the supported way to run `npm run build` output).
 *
 * Why this exists: the standalone Next server (`.next/standalone/server.js`)
 * does `process.chdir(__dirname)` — inside production the working directory
 * becomes `.next/standalone`. Any relative data path (`file:./db/custom.db`,
 * the secret-key file, uploads) would then resolve INSIDE the build output:
 * the app silently forks its SQLite database onto a stale build-time snapshot
 * and generates a second secret key. Bots keep "working" in dev and die in
 * production with no visible error.
 *
 * This launcher makes production deterministic:
 *   1. loads `.env` from the project root (without overriding real env vars),
 *   2. pins NURAE_APP_ROOT to the project root,
 *   3. rewrites a relative `DATABASE_URL` (`file:…`) to an absolute path,
 *   4. boots the standalone server with the project root as its cwd.
 *
 * The app itself additionally guards these paths (src/lib/paths.ts), so even
 * a bare `node .next/standalone/server.js` stays on the right database.
 *
 * Env: PORT (default 3000), HOSTNAME (default 0.0.0.0).
 */

import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serverJs = resolve(root, '.next/standalone/server.js');

if (!existsSync(serverJs)) {
  console.error('[NURAE] Production build not found. Run `npm run build` first.');
  process.exit(1);
}

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

// --- 2. Pin the application root + data home (chdir-immune anchors) -------
process.env.NURAE_APP_ROOT = root;
// Mirror the app's dataRoot() chain (src/lib/paths.ts) so the launcher and
// the server agree on where the database lives BEFORE any app code runs.
// Windows: %LOCALAPPDATA%\FRAZIYM\NURAE (machine-local, not Roaming).
if (!process.env.NURAE_DATA_DIR?.trim() && process.platform === 'win32') {
  const localAppData = process.env.LOCALAPPDATA?.trim() || resolve(homedir(), 'AppData', 'Local');
  process.env.NURAE_DATA_DIR = resolve(localAppData, 'FRAZIYM', 'NURAE');
}
const dataHome = process.env.NURAE_DATA_DIR?.trim() || root;

// --- 3. Make the database URL absolute so it cannot fork on chdir ----------
const dbUrl = process.env.DATABASE_URL?.trim();
if (dbUrl && dbUrl.startsWith('file:')) {
  // Same guard as scripts/db.mjs + src/lib/paths.ts: a Windows %VAR% literal
  // is never expanded by Node and its bare % breaks URL percent-decoding
  // (URL_INVALID: URI malformed on every query). Fail the LAUNCHER with the
  // fix instead of booting a server that cannot answer a single query.
  if (/%(?![0-9A-Fa-f]{2})/.test(dbUrl)) {
    const envRef = /%[A-Za-z_][A-Za-z0-9_]*%/.test(dbUrl);
    console.error(
      envRef
        ? '[NURAE] DATABASE_URL uses a Windows env-var reference like %APPDATA% — Node and ' +
          'libSQL cannot expand %VAR%. FIX: delete the DATABASE_URL line from .env — NURAE ' +
          'then places the database in %LOCALAPPDATA%\\FRAZIYM\\NURAE\\db\\custom.db ' +
          'automatically, or set an absolute path with forward slashes ' +
          '(DATABASE_URL=file:C:/path/to/custom.db). Got: ' +
          dbUrl
        : `[NURAE] DATABASE_URL contains a bare % that is not a valid percent-escape (use %20 for spaces): ${dbUrl}`,
    );
    process.exit(1);
  }
  const path = dbUrl.slice('file:'.length);
  if (path && !path.startsWith(':') && !isAbsolute(path)) {
    // Forward slashes: the canonical Windows form for file: URLs (the prisma
    // CLI chokes on raw backslashes).
    process.env.DATABASE_URL = 'file:' + resolve(dataHome, path).replace(/\\/g, '/');
  }
}

// --- 4. Boot the standalone server from the project root -------------------
process.env.NODE_ENV = 'production';
process.env.PORT = process.env.PORT || '3000';
process.env.HOSTNAME = process.env.HOSTNAME || '0.0.0.0';

console.log(`[NURAE] starting production server (data root: ${dataHome}, port: ${process.env.PORT})`);

const child = spawn(process.execPath, [serverJs], {
  cwd: root,
  env: process.env,
});

// Log to console AND server.log in-process (the old `| tee server.log` shell
// tail only worked on Unix shells — PowerShell/cmd broke `npm start`).
const logStream = createWriteStream(resolve(root, 'server.log'), { flags: 'a' });
logStream.write(`\n[NURAE] ---- server start ${new Date().toISOString()} ----\n`);
const tee = (src) =>
  src.on('data', (chunk) => {
    process.stdout.write(chunk);
    logStream.write(chunk);
  });
if (child.stdout) tee(child.stdout);
if (child.stderr) tee(child.stderr);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code) => {
  logStream.end(`[NURAE] ---- server exit (code ${code ?? 0}) ----\n`);
  process.exit(code ?? 0);
});
