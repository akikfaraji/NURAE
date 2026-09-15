import './helpers';
/**
 * NURAE — BR-031: zero-touch SQLite schema sync on boot.
 *
 * Live failure behind these tests: a deployment updated its code without
 * running `npx prisma db push`; the stale database answered 500 on any route
 * touching a new column/table (admin customers died on site_settings).
 * The boot-time sync must be ON for sqlite, skip managed databases, honor
 * the opt-out, and never crash the boot.
 */

import { describe, expect, test } from 'vitest';

const { syncSqliteSchema } = await import('../../src/lib/nurae/startup/schema-sync');

describe('schema sync guards', () => {
  test('opt-out env disables the sync without spawning anything', async () => {
    const prev = { migrate: process.env.NURAE_AUTO_MIGRATE, url: process.env.DATABASE_URL };
    process.env.NURAE_AUTO_MIGRATE = '0';
    process.env.DATABASE_URL = 'file:/home/z/my-project/db/custom.db';
    try {
      expect(await syncSqliteSchema()).toBe(false);
    } finally {
      if (prev.migrate === undefined) delete process.env.NURAE_AUTO_MIGRATE;
      else process.env.NURAE_AUTO_MIGRATE = prev.migrate;
      if (prev.url !== undefined) process.env.DATABASE_URL = prev.url;
    }
  });

  test('managed (non-file) databases are never auto-pushed', async () => {
    const prev = process.env.DATABASE_URL;
    process.env.NURAE_AUTO_MIGRATE = '1';
    process.env.DATABASE_URL = 'postgresql://user:pass@host:5432/nurae';
    try {
      expect(await syncSqliteSchema()).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prev;
    }
  });

  test('happy path runs prisma db push and reports success (real CLI, test DB)', async () => {
    const prev = { migrate: process.env.NURAE_AUTO_MIGRATE, url: process.env.DATABASE_URL };
    process.env.NURAE_AUTO_MIGRATE = '1';
    // helpers set DATABASE_URL to this run's scratch sqlite file.
    const logSpy = console.log;
    const logs: string[] = [];
    console.log = (msg: unknown) => logs.push(String(msg));
    try {
      const ok = await syncSqliteSchema();
      expect(ok).toBe(true);
      expect(logs.join('\n')).toMatch(/schema sync/i);
    } finally {
      console.log = logSpy;
      if (prev.migrate === undefined) delete process.env.NURAE_AUTO_MIGRATE;
      else process.env.NURAE_AUTO_MIGRATE = prev.migrate;
      if (prev.url !== undefined) process.env.DATABASE_URL = prev.url;
    }
  }, 90_000);
});
