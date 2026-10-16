/**
 * NURAE — AI key health + stored-secret readability tests.
 *
 * Covers the exact incident class the owner hit: a stored per-bot key that is
 * (a) rejected by the provider while the health banner pointed at .env, or
 * (b) undecryptable after the master key changed (NURAE_SECRET_KEY rotation /
 * db-path move) while the banner happily probed the .env fallback instead.
 *
 * The provider probe is exercised against a REAL loopback HTTP stub (the SSRF
 * guard allows loopback by design for Ollama/LM Studio), so classification —
 * 401 → invalid, keySource stored/env — is end-to-end, not mocked internals.
 */

import './helpers';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as http from 'node:http';
import * as crypto from 'node:crypto';

import { pushTestSchema } from './helpers';
pushTestSchema();

const { db } = await import('../../src/lib/db');
const { ensureOfficialBot, OFFICIAL_PROJECT_NAME, OFFICIAL_BOT_NAME } = await import(
  '../../src/lib/nurae/auth/official-bot'
);
const { getAiKeyHealth } = await import('../../src/lib/nurae/ai/key-health');
const { SecretManager, storedSecretsUnreadable } = await import('../../src/lib/nurae/secrets');

// --- helpers -----------------------------------------------------------------

/** Encrypt with a DIFFERENT master key (simulates post-rotation ciphertext). */
function foreignEncrypt(plaintext: string): string {
  const key = crypto.scryptSync('a-completely-different-secret-key', 'nurae-secret-salt-v1', 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), enc.toString('base64url'), cipher.getAuthTag().toString('base64url')].join(':');
}

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

/** OpenRouter-shaped 401 stub on loopback. */
const stub = http.createServer((req, res) => {
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'User not found.', code: 401 } }));
});

beforeAll(async () => {
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
});

afterAll(() => {
  stub.close();
});

async function stubBaseUrl(): Promise<string> {
  const addr = stub.address();
  if (typeof addr !== 'object' || !addr) throw new Error('stub not listening');
  return `http://127.0.0.1:${addr.port}/v1`;
}

/** Point the official CS bot at the loopback stub and set its stored key state. */
async function primeOfficialBot(opts: { apiKeyRef?: string | null; baseUrl?: string | null }) {
  const botId = await ensureOfficialBot();
  expect(botId).toBeTruthy();
  await db.bot.update({
    where: { id: botId! },
    data: { apiKeyRef: opts.apiKeyRef ?? null, baseUrl: opts.baseUrl ?? null },
  });
  return botId!;
}

// --- key health ---------------------------------------------------------------

describe('AI key health (stored vs env precision)', () => {
  test('stored key rejected → status invalid, keySource "stored", fix names bot settings (NOT .env)', async () => {
    const restore = scopedEnv({ OPENROUTER_API_KEY: undefined });
    try {
      await primeOfficialBot({
        apiKeyRef: SecretManager.encrypt('sk-or-v1-stored-but-revoked'),
        baseUrl: await stubBaseUrl(),
      });
      const health = await getAiKeyHealth(true);
      expect(health.status).toBe('invalid');
      expect(health.keySource).toBe('stored');
      expect(health.ok).toBe(false);
      expect(health.detail).toMatch(/stored/i);
      expect(health.detail).toMatch(/bot/i);
      // The old trap: advice must NOT send the owner to .env for a stored key.
      expect(health.detail).not.toMatch(/put it in OPENROUTER_API_KEY/);
    } finally {
      restore();
    }
  });

  test('stored key undecryptable → status "unreadable" even when the env fallback is present', async () => {
    const restore = scopedEnv({ OPENROUTER_API_KEY: 'sk-or-v1-fresh-env-key' });
    try {
      await primeOfficialBot({
        apiKeyRef: foreignEncrypt('encrypted-with-the-old-key'),
        baseUrl: await stubBaseUrl(),
      });
      const health = await getAiKeyHealth(true);
      expect(health.status).toBe('unreadable');
      expect(health.storedUnreadable).toBe(true);
      expect(health.keySource).toBe('stored');
      expect(health.detail).toMatch(/re-enter/i);
      expect(health.detail).toMatch(/override/i);
    } finally {
      restore();
    }
  });

  test('env key rejected (no stored key) → keySource "env", fix names the env var', async () => {
    const restore = scopedEnv({ OPENROUTER_API_KEY: 'sk-or-v1-env-but-dead' });
    try {
      await primeOfficialBot({ apiKeyRef: null, baseUrl: await stubBaseUrl() });
      const health = await getAiKeyHealth(true);
      expect(health.status).toBe('invalid');
      expect(health.keySource).toBe('env');
      expect(health.detail).toMatch(/OPENROUTER_API_KEY/);
    } finally {
      restore();
    }
  });

  test('no stored key and no env key → status "missing"', async () => {
    const restore = scopedEnv({ OPENROUTER_API_KEY: undefined });
    try {
      await primeOfficialBot({ apiKeyRef: null, baseUrl: await stubBaseUrl() });
      const health = await getAiKeyHealth(true);
      expect(health.status).toBe('missing');
      expect(health.keySource).toBeNull();
    } finally {
      restore();
    }
  });
});

// --- official bot / fleet status: secretsUnreadable -----------------------------

describe('official bot status surfaces unreadable secrets', () => {
  test('officialBotStatus reports secretsUnreadable when the stored key is foreign-encrypted', async () => {
    const { officialBotStatus } = await import('../../src/lib/nurae/auth/official-bot');
    const restore = scopedEnv({ OPENROUTER_API_KEY: undefined });
    try {
      await primeOfficialBot({
        apiKeyRef: foreignEncrypt('pre-rotation-secret'),
        baseUrl: await stubBaseUrl(),
      });
      const status = await officialBotStatus();
      expect(status.hasApiKey).toBe(true);
      expect(status.secretsUnreadable).toBe(true);
      // A configured-but-dead bot must not look "ready" to the dashboard.
      expect(status.ready).toBe(false);
    } finally {
      restore();
    }
  });

  test('officialBotStatus is clean when everything is readable or absent', async () => {
    const { officialBotStatus } = await import('../../src/lib/nurae/auth/official-bot');
    const restore = scopedEnv({ OPENROUTER_API_KEY: 'sk-or-v1-env-fallback' });
    try {
      await primeOfficialBot({ apiKeyRef: SecretManager.encrypt('readable-key'), baseUrl: await stubBaseUrl() });
      const status = await officialBotStatus();
      expect(status.secretsUnreadable).toBe(false);

      await primeOfficialBot({ apiKeyRef: null, baseUrl: await stubBaseUrl() });
      const status2 = await officialBotStatus();
      expect(status2.secretsUnreadable).toBe(false);
      expect(status2.hasApiKey).toBe(false);
      expect(status2.ready).toBe(true); // env fallback
    } finally {
      restore();
    }
  });

  test('officialFleetStatus carries secretsUnreadable per fleet row', async () => {
    const { ensureOfficialFleet, officialFleetStatus } = await import('../../src/lib/nurae/auth/official-fleet');
    const restore = scopedEnv({ OPENROUTER_API_KEY: undefined, NURAE_SITE_URL: 'https://nurae.example' });
    try {
      await ensureOfficialFleet({ siteUrl: 'https://nurae.example' });
      const project = await db.project.findFirst({ where: { name: OFFICIAL_PROJECT_NAME } });
      expect(project).toBeTruthy();
      const fleetRow = await db.bot.findFirst({
        where: { projectId: project!.id, name: { not: OFFICIAL_BOT_NAME }, apiKeyRef: { not: null } },
      });
      // Mark one fleet row's stored key unreadable.
      if (fleetRow) {
        await db.bot.update({
          where: { id: fleetRow.id },
          data: { apiKeyRef: foreignEncrypt('fleet-foreign-key') },
        });
      }
      const fleet = await officialFleetStatus();
      expect(fleet.length).toBeGreaterThan(0);
      const flagged = fleet.filter((f) => f.secretsUnreadable === true);
      if (fleetRow) {
        expect(flagged.map((f) => f.botId)).toContain(fleetRow.id);
      } else {
        expect(flagged).toHaveLength(0);
      }
    } finally {
      restore();
    }
  });
});

// --- secrets helper -------------------------------------------------------------

describe('storedSecretsUnreadable', () => {
  test('true when any present ref fails to decrypt; false for readable/absent refs', () => {
    expect(storedSecretsUnreadable(foreignEncrypt('x'))).toBe(true);
    expect(storedSecretsUnreadable(SecretManager.encrypt('fine'))).toBe(false);
    expect(storedSecretsUnreadable(null, undefined)).toBe(false);
    expect(storedSecretsUnreadable(SecretManager.encrypt('fine'), foreignEncrypt('dead'))).toBe(true);
    // A ref encrypted with the CURRENT key never counts as unreadable.
    expect(storedSecretsUnreadable(SecretManager.encrypt('token'), SecretManager.encrypt('key'))).toBe(false);
  });
});
