#!/usr/bin/env node
/**
 * NURAE — postbuild: assemble + PRUNE `.next/standalone` for production.
 *
 * Steps:
 *   1. copy `.next/static`  → `.next/standalone/.next/static` (the standalone
 *      server does not bundle client assets by itself),
 *   2. copy `public`        → `.next/standalone/public`,
 *   3. prune the standalone tree down to an explicit RUNTIME ALLOWLIST.
 *
 * WHY an allowlist (and not the old name denylist):
 * Next's file tracer follows dynamic fs/require calls, so any file the app
 * *might* read gets copied next to server.js. The build was shipping the whole
 * project root into the deploy artifact — 3153 files / 195.7 MB, including
 * worklog.md, bug-reports.md, handoff.md, integration.md, tsconfig.tsbuildinfo,
 * package-lock.json, tests/, docs/, .github/, src/ and six npm_*_install*.log
 * files. The old cleanup removed five hardcoded names
 * (db, upload, .env, dev.log, server.log): it cleaned what was known on that
 * day and silently kept everything else, so the artifact grows (and leaks
 * internal notes/secrets-adjacent files) with every new internal file — or the
 * next rename of an existing one.
 *
 * An allowlist FAILS CLOSED: a path is shipped only when it is explicitly
 * required to serve traffic, so new docs/logs/notes are excluded by default.
 * The prune runs LAST, on every build, which makes it defensive — it also
 * holds if the tracing root cause (dynamic fs access elsewhere in the app) is
 * fixed later, or regresses.
 */

import { cpSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const standalone = resolve(root, '.next/standalone');

// Vercel executes `npm run build` as-is, but its builder traces and packages
// the app itself and never produces .next/standalone (NURAE deliberately
// builds WITHOUT standalone on Vercel — see next.config.ts, the
// vercel/next.js#96657 ENOENT). There is nothing to assemble or prune there.
if (process.env.VERCEL) {
  console.log('[NURAE] postbuild: Vercel build detected — standalone assembly/prune skipped (Vercel packages its own output).');
  process.exit(0);
}

if (!existsSync(resolve(standalone, 'server.js'))) {
  console.error('[NURAE] postbuild: .next/standalone/server.js not found — did `next build` succeed?');
  process.exit(1);
}

// 1+2. Client assets into the standalone bundle.
cpSync(resolve(root, '.next/static'), resolve(standalone, '.next/static'), { recursive: true });
if (existsSync(resolve(root, 'public'))) {
  cpSync(resolve(root, 'public'), resolve(standalone, 'public'), { recursive: true });
}

// ---------------------------------------------------------------------------
// 3. Runtime allowlist
// ---------------------------------------------------------------------------

/**
 * Exactly what a standalone NURAE server needs to run:
 *   server.js     — the entry point scripts/start-prod.mjs executes
 *   package.json  — read by Next at boot (name/version/type resolution)
 *   node_modules  — traced runtime deps + native engines (libsql, sharp,
 *                   @prisma/client — serverExternalPackages keeps them external)
 *   .next         — compiled server chunks, BUILD_ID, manifests,
 *                   .next/static (client assets, copied above)
 *   public        — favicon/logo/robots/llms (copied above)
 *   prisma        — schema.prisma (+ engines), so the artifact can settle its
 *                   own SQLite schema on boot / on demand
 * Anything else in here is build-time scaffolding or internal material.
 */
const RUNTIME_ALLOWLIST = new Set(['server.js', 'package.json', 'node_modules', '.next', 'public', 'prisma']);

/** Entries the server cannot start without — checked after the prune. */
const REQUIRED = ['server.js', '.next', 'node_modules', 'package.json'];

/** Internal material that must never appear in the kept tree (outside deps). */
const INTERNAL_MATERIAL = [/\.log$/i, /\.md$/i, /\.tsbuildinfo$/i, /^package-lock\.json$/i, /^\.env/i];

function dirStats(dir) {
  let files = 0;
  let bytes = 0;
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return; // unreadable directory: nothing to count
    }
    for (const entry of entries) {
      const full = resolve(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        files += 1;
        try {
          bytes += statSync(full).size;
        } catch {
          /* vanished under us — the count still holds */
        }
      }
    }
  };
  walk(dir);
  return { files, bytes };
}

const mb = (bytes) => Math.round((bytes / (1024 * 1024)) * 10) / 10;

const before = dirStats(standalone);

const removed = [];
for (const entry of readdirSync(standalone, { withFileTypes: true })) {
  if (RUNTIME_ALLOWLIST.has(entry.name)) continue;
  const target = resolve(standalone, entry.name);
  // Defensive: never delete outside the build output, whatever a name claims.
  if (dirname(target) !== standalone) continue;
  removed.push(entry.name);
  rmSync(target, { recursive: true, force: true });
}

// Fail the build if the prune took something the server needs.
const missing = REQUIRED.filter((name) => !existsSync(resolve(standalone, name)));
if (missing.length > 0) {
  console.error(`[NURAE] postbuild: standalone bundle is missing required runtime entr${missing.length === 1 ? 'y' : 'ies'}: ${missing.join(', ')}`);
  process.exit(1);
}

// Verification pass: nothing outside node_modules/.next/public should be
// internal material. A hit means the tracer started writing into a kept
// directory — say so loudly instead of shipping it.
const offenders = [];
const scan = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (['node_modules', '.next', 'public'].includes(entry.name)) continue;
      scan(resolve(dir, entry.name));
      continue;
    }
    if (INTERNAL_MATERIAL.some((pattern) => pattern.test(entry.name))) {
      offenders.push(resolve(dir, entry.name).slice(standalone.length + 1));
    }
  }
};
scan(standalone);
if (offenders.length > 0) {
  console.error(`[NURAE] postbuild: internal material found inside the runtime artifact: ${offenders.join(', ')}`);
  console.error('[NURAE] postbuild: refusing to ship it — extend RUNTIME_ALLOWLIST only for real runtime needs.');
  process.exit(1);
}

const after = dirStats(standalone);
console.log(
  `[NURAE] postbuild: pruned ${removed.length} non-runtime top-level entr${removed.length === 1 ? 'y' : 'ies'}` +
    ` (${removed.join(', ')})`,
);
console.log(
  `[NURAE] postbuild: standalone bundle ready — ${before.files} files / ${mb(before.bytes)} MB → ` +
    `${after.files} files / ${mb(after.bytes)} MB`,
);
