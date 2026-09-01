import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Vitest replaces the old bun test runner (bun was removed from the
 * toolchain — everything runs on Node.js now).
 *
 * - The '@' alias mirrors tsconfig's paths ("@/*" -> "./src/*"); Vite does
 *   not read tsconfig paths on its own, and src/ route handlers import via
 *   that alias.
 * - fileParallelism: false keeps the old bun-test behavior where test FILES
 *   run sequentially: the suite shares one SQLite test database and each
 *   file calls pushTestSchema() (prisma db push) on first use — parallel
 *   workers would race on both the schema push and the shared tables.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    fileParallelism: false,
    environment: 'node',
  },
});
