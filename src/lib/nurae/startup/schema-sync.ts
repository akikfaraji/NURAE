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

export async function syncSqliteSchema(): Promise<boolean> {
  if (process.env.NURAE_AUTO_MIGRATE === '0') return false;
  // databaseUrl() (not the raw env): the DEFAULT path must sync too when
  // DATABASE_URL is simply unset, and a malformed URL (e.g. a Windows
  // %APPDATA% reference restored from an old .env) fails HERE with the
  // actionable guard message instead of pushing the schema into a junk
  // database created under a literally-named "%APPDATA%" folder.
  const url = databaseUrl();
  if (!url.startsWith('file:')) return false; // managed databases: real migrations only

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
    return false;
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
    console.log(`[NURAE] schema sync: ${line ?? 'prisma db push completed'}`);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message.split('\n')[0] : String(err);
    console.warn(
      `[NURAE] schema sync FAILED — the database may be missing new columns/tables ` +
        `(run \`npx prisma db push\` manually). Detail: ${message}`,
    );
    return false;
  }
}
