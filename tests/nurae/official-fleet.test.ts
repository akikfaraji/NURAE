/**
 * NURAE — official fleet tests (Task 25): the five built-in promotion bots
 * seeded as platform-owned rows inside the "NURAE Official" project.
 *
 *   - seeding: five rows, platform-owned (ownerId null — unmetered by
 *     design), compiled template behaviors, growth hooks intact
 *   - idempotency: repeat runs seed nothing; admin edits are never touched
 *   - self-healing: a vanished row is re-created and its pointer updated
 *   - env-only boot seeding: skips with no site URL, seeds with
 *     NURAE_SITE_URL (the lazy request-time path is covered by the API test)
 *   - referral code: 'nurae' default, NURAE_REFERRAL_CODE override
 *   - API: GET /api/official-bot exposes the fleet (and completes lazy
 *     seeding at request time) without leaking secret material
 */

import { describe, expect, test, afterAll } from 'vitest';
import { installTelegramStub, resetTelegramStub } from './telegram-stub';

await import('./helpers');
const { pushTestSchema } = await import('./helpers');
pushTestSchema();

const { db } = await import('../../src/lib/db');
const { ensureOfficialBot, OFFICIAL_PROJECT_NAME } = await import('../../src/lib/nurae/auth/official-bot');
const {
  ensureOfficialFleet,
  officialFleetStatus,
  platformReferralCode,
  OFFICIAL_FLEET,
} = await import('../../src/lib/nurae/auth/official-fleet');
const { loadBehaviors } = await import('../../src/lib/nurae/bots/behavior');

installTelegramStub();
afterAll(() => {
  resetTelegramStub();
});

// ---------------------------------------------------------------------------

const LINKS = { siteUrl: 'https://nurae.example' };

function scopedEnv(vars: Record<string, string | undefined>): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

async function fleetBotRows() {
  const project = await db.project.findFirst({ where: { name: OFFICIAL_PROJECT_NAME } });
  expect(project, 'NURAE Official project must exist (CS bot seeds it)').toBeTruthy();
  const rows = await db.bot.findMany({ where: { projectId: project!.id } });
  return { project: project!, rows };
}

async function wipeFleet(): Promise<void> {
  // Remove fleet pointers + their bot rows (CS bot has its own pointer key
  // and is never touched). Pointer values are JSON {botId,v}; v1-era values
  // were a bare botId — handle both.
  for (const spec of OFFICIAL_FLEET) {
    const key = `official_fleet_${spec.templateId}`;
    const pointer = await db.siteSetting.findUnique({ where: { key } });
    if (pointer) {
      let botId = pointer.value;
      try {
        botId = (JSON.parse(pointer.value) as { botId?: string }).botId ?? pointer.value;
      } catch {
        /* legacy bare id */
      }
      await db.bot.deleteMany({ where: { id: botId } });
      await db.siteSetting.delete({ where: { key } });
    }
  }
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

describe('official fleet seeding', () => {
  test('seeds the five fleet bots as platform-owned rows with growth hooks', async () => {
    await ensureOfficialBot(); // owns project creation
    const seeded = await ensureOfficialFleet(LINKS);
    expect(seeded).toBe(5);

    const { project, rows } = await fleetBotRows();
    expect(rows).toHaveLength(6); // 5 fleet + NURAE CS Bot
    const fleetRows = rows.filter((r) => OFFICIAL_FLEET.some((f) => f.botName === r.name));
    expect(fleetRows).toHaveLength(5);

    for (const row of fleetRows) {
      expect(row.projectId).toBe(project.id);
      expect(row.ownerId).toBeNull(); // platform-owned → unmetered by design
      expect(row.provider).toBe('openrouter');
      expect(row.behaviorsJson).toBeTruthy();
      expect(row.telegramTokenRef).toBeNull();
      const behaviors = loadBehaviors(row);
      expect(behaviors.some((b) => b.id === 'nurae_about')).toBe(true); // growth hook
      const welcome = behaviors.find((b) => b.when.type === 'start');
      expect(welcome).toBeTruthy();
      const welcomeText = JSON.stringify(welcome);
      expect(welcomeText).toContain('https://nurae.example/?ref='); // referral link baked in
    }
    const names = fleetRows.map((r) => r.name).sort();
    expect(names).toEqual([
      'NURAE Community Bot',
      'NURAE Giveaway Bot',
      'NURAE Referral Bot',
      'NURAE Support Bot',
      'NURAE Trivia Bot',
    ]);
  });

  test('is idempotent and never overwrites admin edits', async () => {
    expect(await ensureOfficialFleet(LINKS)).toBe(0);

    const { rows } = await fleetBotRows();
    const trivia = rows.find((r) => r.name === 'NURAE Trivia Bot')!;
    await db.bot.update({ where: { id: trivia.id }, data: { name: 'My Renamed Trivia' } });

    expect(await ensureOfficialFleet(LINKS)).toBe(0);
    const after = await db.bot.findUnique({ where: { id: trivia.id } });
    expect(after?.name).toBe('My Renamed Trivia'); // admin edit survives

    // restore for later tests
    await db.bot.update({ where: { id: trivia.id }, data: { name: 'NURAE Trivia Bot' } });
  });

  test('self-heals vanished rows with a fresh pointer', async () => {
    const { rows } = await fleetBotRows();
    const giveaway = rows.find((r) => r.name === 'NURAE Giveaway Bot')!;
    const oldPointer = await db.siteSetting.findUnique({ where: { key: 'official_fleet_giveaway' } });
    expect(JSON.parse(oldPointer!.value)).toMatchObject({ botId: giveaway.id });

    await db.bot.delete({ where: { id: giveaway.id } });
    const seeded = await ensureOfficialFleet(LINKS);
    expect(seeded).toBe(1);

    const newPointer = await db.siteSetting.findUnique({ where: { key: 'official_fleet_giveaway' } });
    expect(JSON.parse(newPointer!.value).botId).not.toBe(giveaway.id);
    const recreated = await db.bot.findUnique({ where: { id: JSON.parse(newPointer!.value).botId } });
    expect(recreated?.name).toBe('NURAE Giveaway Bot');
    expect(loadBehaviors(recreated!).some((b) => b.id === 'nurae_about')).toBe(true);

    const { rows: after } = await fleetBotRows();
    expect(after.filter((r) => OFFICIAL_FLEET.some((f) => f.botName === r.name))).toHaveLength(5);
  });

  test('boot seeding is env-only: skips without a site URL, seeds with NURAE_SITE_URL', async () => {
    await wipeFleet();
    const restore = scopedEnv({ NURAE_SITE_URL: undefined, NURAE_PUBLIC_URL: undefined });
    try {
      expect(await ensureOfficialFleet()).toBe(0); // no site URL — deferred to lazy request path
      const { rows } = await fleetBotRows();
      expect(rows.filter((r) => r.name !== 'NURAE CS Bot')).toHaveLength(0);

      process.env.NURAE_SITE_URL = 'https://boot.example';
      expect(await ensureOfficialFleet()).toBe(5);
      const { rows: after } = await fleetBotRows();
      const hub = after.find((r) => r.name === 'NURAE Community Bot')!;
      expect(JSON.stringify(loadBehaviors(hub))).toContain('https://boot.example/?ref=');
    } finally {
      restore();
    }
  });

  test('platformReferralCode: nurae default, env override', async () => {
    const restore = scopedEnv({ NURAE_REFERRAL_CODE: undefined });
    try {
      expect(platformReferralCode()).toBe('nurae');
      process.env.NURAE_REFERRAL_CODE = 'OWNERCODE42';
      expect(platformReferralCode()).toBe('OWNERCODE42');
    } finally {
      restore();
    }
  });

  test('v1 fleet rows auto-upgrade to the current template (secrets preserved)', async () => {
    // Simulate a v1-era fleet row: current pointer format is JSON {botId,v},
    // v1 pointers were a bare botId. Set a token to prove it survives.
    const { rows } = await fleetBotRows();
    const trivia = rows.find((r) => r.name === 'NURAE Trivia Bot')!;
    await db.bot.update({
      where: { id: trivia.id },
      data: { telegramTokenRef: 'v1:test:encrypted', systemPrompt: 'v1 prompt' },
    });
    await db.siteSetting.update({
      where: { key: 'official_fleet_daily-trivia' },
      data: { value: trivia.id }, // legacy bare-id pointer → parsed as v1
    });

    const changed = await ensureOfficialFleet(LINKS);
    expect(changed).toBe(1); // one row upgraded (the other four are current)

    const upgraded = await db.bot.findUnique({ where: { id: trivia.id } });
    expect(upgraded?.telegramTokenRef).toBe('v1:test:encrypted'); // secret kept
    expect(upgraded?.systemPrompt).not.toBe('v1 prompt'); // config refreshed
    const behaviors = loadBehaviors(upgraded!);
    expect(behaviors.some((b) => b.when.type === 'start' && b.steps.some((s) => s.type === 'streak'))).toBe(true);
    expect(behaviors.some((b) => b.id === 'group_greet')).toBe(true);
    const pointer = await db.siteSetting.findUnique({ where: { key: 'official_fleet_daily-trivia' } });
    expect(JSON.parse(pointer!.value)).toMatchObject({ botId: trivia.id, v: 2 });
  });

  test('officialFleetStatus lists five entries with no secrets', async () => {
    const status = await officialFleetStatus();
    expect(status).toHaveLength(5);
    for (const entry of status) {
      expect(entry.botId).toBeTruthy();
      expect(entry.tagline.length).toBeGreaterThan(0);
      expect(JSON.stringify(entry)).not.toContain('v1:'); // encrypted material never leaves
      expect(Object.keys(entry)).not.toContain('telegramTokenRef');
    }
    expect(status.map((s) => s.templateId).sort()).toEqual([
      'community-hub',
      'daily-trivia',
      'giveaway',
      'referral-ambassador',
      'support-faq',
    ]);
  });
});

// ---------------------------------------------------------------------------
// API — GET /api/official-bot (lazy fleet seeding at request time)
// ---------------------------------------------------------------------------

describe('official fleet API', () => {
  test('GET /api/official-bot exposes the fleet and lazy-seeds it', async () => {
    await wipeFleet(); // prove the request path completes seeding itself
    const restore = scopedEnv({ NURAE_SITE_URL: undefined, NURAE_PUBLIC_URL: undefined });
    try {
      const route = await import('../../src/app/api/official-bot/route');
      const res = await route.GET(new Request('http://localhost:3000/api/official-bot'));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        official: { botId: string | null };
        fleet: Array<{ templateId: string; botId: string | null; name: string; category: string }>;
      };
      expect(body.fleet).toHaveLength(5);
      for (const entry of body.fleet) {
        expect(entry.botId).toBeTruthy();
        expect(entry.name).toMatch(/^NURAE /);
      }
      // No secret material anywhere in the response.
      expect(JSON.stringify(body)).not.toContain('v1:');
      // The CS bot is still present, untouched, with its own card payload.
      expect(body.official.botId).toBeTruthy();
    } finally {
      restore();
    }
  });
});
