/**
 * NURAE — test bootstrap.
 * Test files dynamic-import this FIRST (before any NURAE module) so that the
 * environment points at an isolated test database, never the developer's data.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Unique temp directory per test process → fully isolated DB.
export const TEST_DIR = mkdtempSync(join(tmpdir(), 'nurae-test-'));
export const TEST_DB_URL = `file:${join(TEST_DIR, 'test.db')}`;

process.env.DATABASE_URL = TEST_DB_URL;
// Keep provider env fallbacks out of tests unless a test sets them explicitly.
delete process.env.OPENAI_API_KEY;
delete process.env.OPENROUTER_API_KEY;
delete process.env.DEEPSEEK_API_KEY;
delete process.env.GLM_API_KEY;
delete process.env.LOCAL_API_KEY;
delete process.env.CUSTOM_API_KEY;
process.env.NURAE_SECRET_KEY = process.env.NURAE_SECRET_KEY || 'nurae-test-secret-key-0123456789abcdef';

/** Apply the Prisma schema to the test DB (idempotent). */
let schemaPushed = false;
export function pushTestSchema(): void {
  if (schemaPushed) return;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { execSync } = require('node:child_process') as typeof import('node:child_process');
  execSync(`bunx prisma db push --skip-generate --accept-data-loss`, {
    cwd: '/home/z/my-project',
    env: { ...process.env, DATABASE_URL: TEST_DB_URL },
    stdio: 'ignore',
  });
  schemaPushed = true;
}
