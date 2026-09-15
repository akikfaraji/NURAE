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

import { existsSync } from 'node:fs';

export async function syncSqliteSchema(): Promise<boolean> {
  if (process.env.NURAE_AUTO_MIGRATE === '0') return false;
  const url = process.env.DATABASE_URL ?? '';
  if (!url.startsWith('file:')) return false; // managed databases: real migrations only

  const cliPath = `${process.cwd()}/node_modules/prisma/build/index.js`;
  if (!existsSync(cliPath)) {
    console.warn('[NURAE] schema sync skipped — prisma CLI not installed in this deployment');
    return false;
  }

  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const { stdout } = await run(process.execPath, [cliPath, 'db', 'push', '--skip-generate'], {
      timeout: 60_000,
      env: process.env,
    });
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
