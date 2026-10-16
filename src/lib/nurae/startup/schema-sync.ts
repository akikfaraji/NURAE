/**
 * NURAE — zero-touch SQLite schema sync (BR-031).
 *
 * Live failure: a deployment upgraded its code but never ran
 * `npx prisma db push`, so the database lagged behind the schema and every
 * route touching a new column/table answered 500 (the admin customers page
 * died on `site_settings`). Manual migration steps are exactly the kind of
 * thing a no-code product must not depend on.
 *
 * On boot (before anything queries the DB) we ask the locally installed
 * Prisma CLI to push the schema — additive and idempotent. Destructive
 * changes still refuse to run (no --accept-data-loss) and only produce a
 * loud warning. NURAE_AUTO_MIGRATE=0 opts out.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { databaseUrl } from '@/lib/paths';
import type { SchemaSyncOutcome } from './boot-state';

/**
 * Why a sync did or did not run — the boolean is not enough for readiness:
 * "schema handled elsewhere" (opt-out / managed database) and "schema could
 * not be settled" (CLI missing, push failed) must not look the same, because
 * the second one means routes touching new columns/tables will 500.
 */
export async function syncSqliteSchemaDetailed(): Promise<SchemaSyncOutcome> {
  if (process.env.NURAE_AUTO_MIGRATE === '0') {
    return { ok: false, status: 'skipped-opt-out', detail: 'NURAE_AUTO_MIGRATE=0 — schema sync disabled' };
  }
  // databaseUrl() (not the raw env): the DEFAULT path must sync too when
  // DATABASE_URL is simply unset, and a malformed URL (e.g. a Windows
  // %APPDATA% reference restored from an old .env) fails HERE with the
  // actionable guard message instead of pushing the schema into a junk
  // database created under a literally-named "%APPDATA%" folder.
  const url = databaseUrl();
  if (!url.startsWith('file:')) {
    // managed databases: real migrations only
    return { ok: false, status: 'skipped-managed', detail: 'managed (non-file) database URL — migrations are the operator’s job' };
  }

  // The standalone server chdirs into .next/standalone, where neither the
  // prisma schema nor the project node_modules live. Anchor the CLI + schema
  // to NURAE_APP_ROOT (pinned by scripts/start-prod.mjs); the DATABASE is
  // anchored to the data root (project root on Linux,
  // %LOCALAPPDATA%\FRAZIYM\NURAE on Windows). Dev falls back to cwd.
  const appRoot = process.env.NURAE_APP_ROOT || process.cwd();
  const cliPath = join(appRoot, 'node_modules', 'prisma', 'build', 'index.js');
  const schemaPath = join(appRoot, 'prisma', 'schema.prisma');
  if (!existsSync(cliPath) || !existsSync(schemaPath)) {
    console.warn('[NURAE] schema sync skipped — prisma CLI or schema not found in this deployment');
    return {
      ok: false,
      status: 'skipped-missing-cli',
      detail: `prisma CLI or prisma/schema.prisma not found under ${appRoot} — run \`npx prisma db push\` manually`,
    };
  }

  // The prisma CLI is a child process — it cannot apply the app's dataRoot()
  // logic, so hand it the already-absolute database URL, and pre-create the
  // directory (a fresh Windows install has no db/ folder yet). The CLI
  // gets forward slashes: file:C:/… is the canonical Windows form for prisma
  // file: URLs (raw backslashes break its URL parsing).
  const absoluteUrl = databaseUrl();
  const dbFile = absoluteUrl.startsWith('file:') ? absoluteUrl.slice('file:'.length) : null;
  if (dbFile) mkdirSync(dirname(dbFile), { recursive: true });
  const cliUrl = absoluteUrl.replace(/\\/g, '/');

  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const { stdout } = await run(
      process.execPath,
      [cliPath, 'db', 'push', '--skip-generate', '--schema', schemaPath],
      { timeout: 60_000, env: { ...process.env, DATABASE_URL: cliUrl } },
    );
    const line = stdout.split('\n').find((l) => l.includes('sync') || l.includes('up to date'))?.trim();
    const detail = line ?? 'prisma db push completed';
    console.log(`[NURAE] schema sync: ${detail}`);
    return { ok: true, status: 'synced', detail };
  } catch (err) {
    const message = err instanceof Error ? err.message.split('\n')[0] : String(err);
    console.warn(
      `[NURAE] schema sync FAILED — the database may be missing new columns/tables ` +
        `(run \`npx prisma db push\` manually). Detail: ${message}`,
    );
    return { ok: false, status: 'failed', detail: message };
  }
}

/**
 * Boolean wrapper — the historical contract, preserved for existing callers
 * (and their tests): true only when the schema is now in sync with the schema
 * file. Boot readiness uses syncSqliteSchemaDetailed() to tell "settled
 * elsewhere" from "could not be settled".
 */
export async function syncSqliteSchema(): Promise<boolean> {
  return (await syncSqliteSchemaDetailed()).ok;
}
