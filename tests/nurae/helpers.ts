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
// WHY '' AND NOT delete: @prisma/client re-loads the project .env when the
// PrismaClient is constructed (fill-in mode) — any var left `undefined` is
// REFILLED from the developer's real .env at `import('../../src/lib/db')`
// time, resurrecting e.g. NURAE_ADMIN_TOKEN. A set-but-empty string survives
// that refill, and every NURAE consumer treats '' as "not configured":
//   adminToken(): ''.trim().length > 0 → false → open-admin (localhost mode)
//   transport: (NURAE_BOT_TRANSPORT || 'webhook') → '' is falsy → webhook
//   gateway-link / provider fallbacks / DATABASE_AUTH_TOKEN: same falsy guards.
process.env.OPENAI_API_KEY = '';
process.env.OPENROUTER_API_KEY = '';
process.env.DEEPSEEK_API_KEY = '';
process.env.GLM_API_KEY = '';
process.env.LOCAL_API_KEY = '';
process.env.CUSTOM_API_KEY = '';
process.env.NURAE_SECRET_KEY = process.env.NURAE_SECRET_KEY || 'nurae-test-secret-key-0123456789abcdef';
// Auth/transport/gateway: the suite manages these itself (open-admin default;
// per-test tokens/keys). A developer's real .env must not leak into tests.
process.env.NURAE_ADMIN_TOKEN = '';
process.env.DATABASE_AUTH_TOKEN = '';
process.env.NURAE_BOT_TRANSPORT = '';
process.env.NURAE_PUBLIC_BASE_URL = '';
process.env.NURAE_LINK_FRONTEND_URL = '';
process.env.NURAE_GATEWAY_KEY = '';
process.env.NURAE_TELEGRAM_API_BASE = '';
process.env.NURAE_BACKEND_URL = '';

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
