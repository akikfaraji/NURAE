#!/usr/bin/env node
/**
 * NURAE — dev launcher (the Windows-safe replacement for `2>&1 | tee dev.log`).
 *
 * The old dev script piped through the shell `tee` utility: it breaks on
 * cmd.exe entirely and on PowerShell only half-works (alias quirks, stream
 * re-encoding). Same in-process tee as scripts/start-prod.mjs: spawn the
 * next dev server, forward its output to the console AND dev.log, keep
 * stdin inherited so the interactive shortcuts (r / o / etc.) still work.
 *
 * Env: PORT (default 3000). The database resolves through src/lib/paths.ts
 * exactly like production — %LOCALAPPDATA%\FRAZIYM\NURAE on Windows.
 */

import { createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = process.env.PORT || '3000';

console.log(`[NURAE] dev server on http://localhost:${port} (log: dev.log)`);

const child = spawn(
  process.execPath,
  [resolve(root, 'node_modules', 'next', 'dist', 'bin', 'next'), 'dev', '-p', port],
  { cwd: root, env: process.env, stdio: ['inherit', 'pipe', 'pipe'] },
);

const logStream = createWriteStream(resolve(root, 'dev.log'), { flags: 'a' });
logStream.write(`\n[NURAE] ---- dev server start ${new Date().toISOString()} ----\n`);
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
  logStream.end(`[NURAE] ---- dev server exit (code ${code ?? 0}) ----\n`);
  process.exit(code ?? 0);
});
