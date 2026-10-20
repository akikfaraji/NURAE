/**
 * NURAE — test bootstrap.
 * Test files dynamic-import this FIRST (before any NURAE module) so that the
 * environment points at an isolated test database, never the developer's data.
 */

import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Repository root, derived from THIS file's own location
 * (`tests/nurae/helpers.ts` → two levels up). This is the ESM equivalent of
 * `__dirname`, and it is the ONLY place the suite is allowed to learn where
 * the repo lives: a hardcoded absolute path works on exactly one machine, and
 * the suite must run from any checkout on any OS. Deriving it from
 * `import.meta.url` (rather than `process.cwd()`) also keeps it correct when
 * vitest is launched from a parent directory.
 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Unique temp directory per test process → fully isolated DB.
export const TEST_DIR = mkdtempSync(join(tmpdir(), 'nurae-test-'));
// Forward slashes on purpose: `file:C:/…` is the canonical Windows form for
// prisma/libSQL file: URLs. join() yields backslashes on Windows; the Prisma
// CLI tolerates them on this toolchain (verified by probe), but canonicalising
// here keeps the URL the CLI receives byte-identical to the one the app's
// adapter opens (databaseUrl() in src/lib/paths.ts, and the boot schema sync)
// — so both consumers demonstrably address ONE file, and the suite inherits
// the production URL convention instead of depending on CLI leniency.
export const TEST_DB_URL = `file:${join(TEST_DIR, 'test.db').replace(/\\/g, '/')}`;

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
process.env.ORCA_API_KEY = '';
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
// Platform layer (Task 13): keep the developer's real Gmail/Google config out
// of tests — empty strings survive the Prisma .env refill (see above).
process.env.NURAE_GMAIL_USER = '';
process.env.NURAE_GMAIL_APP_PASSWORD = '';
process.env.NURAE_GOOGLE_CLIENT_ID = '';
process.env.NURAE_GOOGLE_CLIENT_SECRET = '';
process.env.NURAE_PUBLIC_URL = '';

/** Apply the Prisma schema to the test DB. The PrismaClient is module-cached
 *  across the whole bun test process, so every file shares one database —
 *  therefore every call AFTER the first force-resets it: each test file
 *  starts from a pristine, fully-migrated DB no matter which files ran
 *  before it. (Without the reset, files that seed fleets/users would fail
 *  their "empty platform" assumptions in full-suite runs.) */
let schemaPushed = false;
export function pushTestSchema(): void {
  const reset = schemaPushed ? ' --force-reset' : '';
  // Direct entry path + explicit node: immune to `bunx` shebang resolution on
  // node-less boxes (same reason package.json scripts use this form).
  // cwd MUST be the repo root: the command resolves BOTH the CLI
  // (node_modules/prisma/build/index.js) AND the schema (prisma/schema.prisma)
  // relative to it. The previous value was a hardcoded Linux sandbox path
  // ('/home/z/my-project'), so on Windows the spawn failed for a nonexistent
  // cwd and EVERY DB-backed file died at import time.
  execSync(`node node_modules/prisma/build/index.js db push --skip-generate --accept-data-loss${reset}`, {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: TEST_DB_URL },
    stdio: 'ignore',
  });
  schemaPushed = true;
}
