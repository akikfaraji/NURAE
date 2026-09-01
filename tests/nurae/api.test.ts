/**
 * NURAE — API route tests (Steps 6, 7, 12, 13: projects, bots, config,
 * lifecycle, logs; security: secrets never returned, invalid requests
 * rejected, unauthorized operations rejected).
 *
 * Route handlers are imported directly and invoked with Request objects —
 * no HTTP server needed. Since beta-02 the bot runtime lives inside the app:
 * the Telegram Bot API is stubbed at the fetch level (stateful webhook
 * registry), so the real webhook-mode lifecycle runs end-to-end in-process.
 */

import { describe, expect, test, afterAll } from 'bun:test';
import { installTelegramStub, resetTelegramStub, telegramState, STUB_TELEGRAM_TOKEN } from './telegram-stub';

await import('./helpers');
const { pushTestSchema } = await import('./helpers');
pushTestSchema();
// With the env set, import the modules under test.
const { db } = await import('../../src/lib/db');
const projectsRoute = await import('../../src/app/api/projects/route');
const projectDetailRoute = await import('../../src/app/api/projects/[id]/route');
const projectBotsRoute = await import('../../src/app/api/projects/[id]/bots/route');
const botDetailRoute = await import('../../src/app/api/bots/[id]/route');
const botConfigRoute = await import('../../src/app/api/bots/[id]/config/route');
const botStartRoute = await import('../../src/app/api/bots/[id]/start/route');
const botStopRoute = await import('../../src/app/api/bots/[id]/stop/route');
const botRestartRoute = await import('../../src/app/api/bots/[id]/restart/route');
const botStatusRoute = await import('../../src/app/api/bots/[id]/status/route');
const botLogsRoute = await import('../../src/app/api/bots/[id]/logs/route');
const healthRoute = await import('../../src/app/api/health/route');
const statsRoute = await import('../../src/app/api/stats/route');
const catalogRoute = await import('../../src/app/api/catalog/route');
const authLoginRoute = await import('../../src/app/api/auth/login/route');
const authStatusRoute = await import('../../src/app/api/auth/status/route');

type Ctx = { params: Promise<{ id: string }> };
const ctx = (id: string): Ctx => ({ params: Promise.resolve({ id }) });

const jsonReq = (url: string, body?: unknown, extra?: RequestInit): Request =>
  new Request(`http://localhost:3000${url}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...extra,
  });

// Stub: Telegram Bot API (stateful webhook registry) + OpenAI-compatible AI
// live in tests/nurae/telegram-stub.ts (shared with webhook.test.ts).
installTelegramStub();

delete process.env.NURAE_BOT_TRANSPORT; // default = webhook

afterAll(async () => {
  resetTelegramStub();
  await db.$disconnect();
});

// ---------------------------------------------------------------------------
// Health / catalog / stats
// ---------------------------------------------------------------------------

describe('health & metadata', () => {
  test('GET /api/health returns the NURAE version (spec §13)', async () => {
    const res = await healthRoute.GET();
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.version).toBe('V00.01.006-beta-03');
    expect(body.vendor).toBe('FRAZIYM TECH & AI');
  });

  test('GET /api/catalog lists providers and never contains secrets', async () => {
    const res = await catalogRoute.GET(jsonReq('/api/catalog'));
    const body = (await res.json()) as { providers: Array<{ id: string; requiresKey: boolean }>; limits: unknown };
    expect(res.status).toBe(200);
    expect(body.providers.length).toBeGreaterThanOrEqual(7);
    expect(JSON.stringify(body).toLowerCase()).not.toContain('secret_');
  });
});

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

describe('projects API', () => {
  test('create + list + get project', async () => {
    const createRes = await projectsRoute.POST(jsonReq('/api/projects', { name: 'Ops', description: 'Core ops' }));
    expect(createRes.status).toBe(201);
    const { project } = (await createRes.json()) as { project: { id: string; name: string } };
    expect(project.name).toBe('Ops');

    const listRes = await projectsRoute.GET(jsonReq('/api/projects'));
    const listBody = (await listRes.json()) as { projects: Array<{ id: string }> };
    expect(listBody.projects.some((p) => p.id === project.id)).toBe(true);

    const getRes = await projectDetailRoute.GET(jsonReq(`/api/projects/${project.id}`), ctx(project.id));
    const getBody = (await getRes.json()) as { project: { id: string }; bots: unknown[] };
    expect(getBody.project.id).toBe(project.id);
    expect(getBody.bots).toEqual([]);
  });

  test('invalid project payload → 422 with field errors', async () => {
    const res = await projectsRoute.POST(jsonReq('/api/projects', { name: '' }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { fields: Record<string, string> };
    expect(body.fields.name).toBeTruthy();
  });

  test('malformed JSON body → 400', async () => {
    const req = new Request('http://localhost:3000/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{oops',
    });
    const res = await projectsRoute.POST(req);
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Bots
// ---------------------------------------------------------------------------

describe('bots API', () => {
  let projectId = '';
  let botId = '';

  test('create bot under project (token encrypted at rest)', async () => {
    const pRes = await projectsRoute.POST(jsonReq('/api/projects', { name: 'Bots project' }));
    projectId = ((await pRes.json()) as { project: { id: string } }).project.id;

    const res = await projectBotsRoute.POST(
      jsonReq(`/api/projects/${projectId}/bots`, {
        name: 'Support',
        telegramToken: '1234567890:AAValidFormatTokenForTesting1234',
        provider: 'zai',
        model: 'glm-4.5-flash',
        systemPrompt: 'You are a helpful customer-support assistant.',
        temperature: 0.4,
        maxTokens: 512,
        memorySize: 8,
      }),
      ctx(projectId),
    );
    expect(res.status).toBe(201);
    const { bot } = (await res.json()) as { bot: Record<string, unknown> };

    botId = bot.id as string;
    // Secret-free DTO: no encrypted refs, no token material.
    expect(bot.hasTelegramToken).toBe(true);
    expect(bot.telegramTokenRef).toBeUndefined();
    expect(bot.apiKeyRef).toBeUndefined();
    expect(bot.transport).toBeNull();
    expect(JSON.stringify(bot)).not.toContain('AAValidFormatTokenForTesting1234');

    // And the raw row indeed stores ciphertext, not plaintext.
    const row = await db.bot.findUnique({ where: { id: botId } });
    expect(row!.telegramTokenRef.startsWith('v1:')).toBe(true);
    expect(row!.telegramTokenRef).not.toContain('AAValidFormatTokenForTesting1234');
  });

  test('bot with provider requiring a key but no key → 422', async () => {
    const res = await projectBotsRoute.POST(
      jsonReq(`/api/projects/${projectId}/bots`, {
        name: 'Bad',
        telegramToken: '1234567890:AAValidFormatTokenForTesting1234',
        provider: 'openai',
        model: 'gpt-4o-mini',
      }),
      ctx(projectId),
    );
    expect(res.status).toBe(422);
  });

  test('bot with malformed telegram token → 422', async () => {
    const res = await projectBotsRoute.POST(
      jsonReq(`/api/projects/${projectId}/bots`, { name: 'Bad token', telegramToken: 'not-a-token', provider: 'zai', model: 'glm-4.5-flash' }),
      ctx(projectId),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { fields: Record<string, string> };
    expect(body.fields.telegramToken).toBeTruthy();
  });

  test('temperature out of range → 422', async () => {
    const res = await projectBotsRoute.POST(
      jsonReq(`/api/projects/${projectId}/bots`, {
        name: 'Hot',
        telegramToken: '1234567890:AAValidFormatTokenForTesting1234',
        provider: 'zai',
        model: 'glm-4.5-flash',
        temperature: 5,
      }),
      ctx(projectId),
    );
    expect(res.status).toBe(422);
  });

  test('GET bot detail includes runtime block and no secrets', async () => {
    const res = await botDetailRoute.GET(jsonReq(`/api/bots/${botId}`), ctx(botId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bot: Record<string, unknown>; runtime: { managed: boolean; status: string; transport: string | null } };
    expect(body.bot.id).toBe(botId);
    // Never started → not managed, no transport, persisted status shown.
    expect(body.runtime.managed).toBe(false);
    expect(body.runtime.status).toBe('stopped');
    expect(body.runtime.transport).toBeNull();
    expect(JSON.stringify(body)).not.toContain('v1:');
  });

  test('PUT /config updates configuration fields', async () => {
    const res = await botConfigRoute.PUT(
      jsonReq(`/api/bots/${botId}/config`, { systemPrompt: 'Updated prompt', temperature: 1.2, maxTokens: 2048 }),
      ctx(botId),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bot: { systemPrompt: string; temperature: number; maxTokens: number }; restartNeeded: boolean };
    expect(body.bot.systemPrompt).toBe('Updated prompt');
    expect(body.bot.temperature).toBe(1.2);
    expect(body.bot.maxTokens).toBe(2048);
  });

  test('PUT /config with invalid temperature → 422', async () => {
    const res = await botConfigRoute.PUT(jsonReq(`/api/bots/${botId}/config`, { temperature: 99 }), ctx(botId));
    expect(res.status).toBe(422);
  });

  test('start / stop / restart drive the webhook transport end-to-end', async () => {
    telegramState.mode = 'ok';

    const start = await botStartRoute.POST(jsonReq(`/api/bots/${botId}/start`, {}), ctx(botId));
    expect(start.status).toBe(200);
    const startBody = (await start.json()) as { bot: { status: string; transport: string | null; telegramUsername: string | null }; runtime: { status: string } };
    expect(startBody.bot.status).toBe('running');
    expect(startBody.bot.transport).toBe('webhook');
    expect(startBody.bot.telegramUsername).toBe('@stub_bot');
    expect(startBody.runtime.status).toBe('running');

    // The stubbed Telegram actually received setWebhook with a secret + our URL.
    const wh = telegramState.registry.get(STUB_TELEGRAM_TOKEN);
    expect(wh?.url).toBe(`http://localhost:3000/api/telegram/webhook/${botId}`);
    expect(wh?.secret.length).toBeGreaterThanOrEqual(32);

    // The webhook secret is stored encrypted, never in plaintext.
    const row = await db.bot.findUnique({ where: { id: botId } });
    expect(row!.webhookSecretRef?.startsWith('v1:')).toBe(true);
    expect(row!.webhookSecretRef).not.toContain(wh!.secret);

    const stop = await botStopRoute.POST(jsonReq(`/api/bots/${botId}/stop`, {}), ctx(botId));
    expect(stop.status).toBe(200);
    const stopBody = (await stop.json()) as { bot: { status: string } };
    expect(stopBody.bot.status).toBe('stopped');
    expect(telegramState.registry.has(STUB_TELEGRAM_TOKEN)).toBe(false);

    const restart = await botRestartRoute.POST(jsonReq(`/api/bots/${botId}/restart`, {}), ctx(botId));
    expect(restart.status).toBe(200);
    const restartBody = (await restart.json()) as { bot: { status: string } };
    expect(restartBody.bot.status).toBe('running');
  });

  test('starting an already-running bot is rejected (state machine)', async () => {
    const res = await botStartRoute.POST(jsonReq(`/api/bots/${botId}/start`, {}), ctx(botId));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('running');
  });

  test('invalid Telegram token → start fails with a clear, secret-free error', async () => {
    // Stop the running bot first.
    await botStopRoute.POST(jsonReq(`/api/bots/${botId}/stop`, {}), ctx(botId));

    telegramState.mode = 'invalid-token';
    try {
      const res = await botStartRoute.POST(jsonReq(`/api/bots/${botId}/start`, {}), ctx(botId));
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('401');
      // Bot went to error state with the detail persisted.
      const status = await botStatusRoute.GET(jsonReq(`/api/bots/${botId}/status`), ctx(botId));
      const statusBody = (await status.json()) as { persistedStatus: string; statusDetail: string | null };
      expect(statusBody.persistedStatus).toBe('error');
      expect(statusBody.statusDetail).toContain('401');
    } finally {
      telegramState.mode = 'ok';
    }
  });

  test('status endpoint merges persisted + live webhook state', async () => {
    // Start again (webhook registered by the stub).
    await botStartRoute.POST(jsonReq(`/api/bots/${botId}/start`, {}), ctx(botId));
    const res = await botStatusRoute.GET(jsonReq(`/api/bots/${botId}/status`), ctx(botId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      botId: string;
      status: string;
      persistedStatus: string;
      runtimeManaged: boolean;
      transport: string | null;
      pendingUpdateCount: number | null;
    };
    expect(body.botId).toBe(botId);
    expect(body.status).toBe('running');
    expect(body.persistedStatus).toBe('running');
    expect(body.runtimeManaged).toBe(true);
    expect(body.transport).toBe('webhook');
    expect(body.pendingUpdateCount).toBe(0);

    await botStopRoute.POST(jsonReq(`/api/bots/${botId}/stop`, {}), ctx(botId));
  });

  test('logs endpoint returns sanitized entries; level filter works', async () => {
    await db.log.create({ data: { botId, level: 'info', message: `created with token 1234567890:AAValidFormatTokenForTesting1234` } });
    await db.log.create({ data: { botId, level: 'warn', message: 'warning entry' } });

    const res = await botLogsRoute.GET(jsonReq(`/api/bots/${botId}/logs`), ctx(botId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { logs: Array<{ level: string; message: string }> };
    expect(body.logs.length).toBeGreaterThanOrEqual(2);
    // The token leaked into a log line must be redacted on read (defense in depth).
    expect(JSON.stringify(body.logs)).not.toContain('AAValidFormatTokenForTesting1234');

    const errRes = await botLogsRoute.GET(jsonReq(`/api/bots/${botId}/logs?level=warn`), ctx(botId));
    const errBody = (await errRes.json()) as { logs: Array<{ level: string }> };
    expect(errBody.logs.every((l) => l.level === 'warn')).toBe(true);
  });

  test('delete bot removes cascaded data', async () => {
    const del = await botDetailRoute.DELETE(jsonReq(`/api/bots/${botId}`), ctx(botId));
    expect(del.status).toBe(200);
    expect(await db.bot.findUnique({ where: { id: botId } })).toBeNull();
  });

  test('unknown bot id → 404', async () => {
    const res = await botDetailRoute.GET(jsonReq('/api/bots/does-not-exist'), ctx('does-not-exist'));
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

describe('stats API', () => {
  test('returns overview counters', async () => {
    const res = await statsRoute.GET(jsonReq('/api/stats'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stats: { projects: number; activeBots: number; stoppedBots: number; errors: number } };
    expect(typeof body.stats.projects).toBe('number');
    expect(typeof body.stats.activeBots).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// Security — authentication & authorization
// ---------------------------------------------------------------------------

describe('security (spec §18, §19)', () => {
  test('auth status reflects configuration', async () => {
    delete process.env.NURAE_ADMIN_TOKEN;
    const res = await authStatusRoute.GET(jsonReq('/api/auth/status'));
    const body = (await res.json()) as { authRequired: boolean; authenticated: boolean };
    expect(body.authRequired).toBe(false);
    expect(body.authenticated).toBe(true);
  });

  test('login rejects wrong token and accepts the correct one', async () => {
    process.env.NURAE_ADMIN_TOKEN = 'top-secret-admin-token';
    try {
      const bad = await authLoginRoute.POST(jsonReq('/api/auth/login', { token: 'wrong' }));
      expect(bad.status).toBe(401);

      const good = await authLoginRoute.POST(jsonReq('/api/auth/login', { token: 'top-secret-admin-token' }));
      expect(good.status).toBe(200);
      const setCookie = good.headers.get('set-cookie') ?? '';
      expect(setCookie).toContain('nurae_admin=');
      expect(setCookie).toContain('HttpOnly');

      // With auth enabled, admin endpoints reject unauthenticated requests…
      const denied = await projectsRoute.GET(jsonReq('/api/projects'));
      expect(denied.status).toBe(401);

      // …and accept the bearer credential.
      const allowed = await projectsRoute.GET(
        new Request('http://localhost:3000/api/projects', {
          headers: { Authorization: 'Bearer top-secret-admin-token' },
        }),
      );
      expect(allowed.status).toBe(200);

      // Cookie auth works too.
      const viaCookie = await projectsRoute.GET(
        new Request('http://localhost:3000/api/projects', {
          headers: { Cookie: 'nurae_admin=top-secret-admin-token' },
        }),
      );
      expect(viaCookie.status).toBe(200);
    } finally {
      delete process.env.NURAE_ADMIN_TOKEN;
    }
  });

  test('protected bot endpoints reject unauthorized operations', async () => {
    process.env.NURAE_ADMIN_TOKEN = 'another-secret';
    try {
      const res = await botStartRoute.POST(
        new Request('http://localhost:3000/api/bots/x/start', { method: 'POST' }),
        ctx('x'),
      );
      expect(res.status).toBe(401);
    } finally {
      delete process.env.NURAE_ADMIN_TOKEN;
    }
  });

  test('AI responses never echo secrets: bot DTO stays clean end-to-end', async () => {
    const pRes = await projectsRoute.POST(jsonReq('/api/projects', { name: 'Sec' }));
    const pid = ((await pRes.json()) as { project: { id: string } }).project.id;
    const bRes = await projectBotsRoute.POST(
      jsonReq(`/api/projects/${pid}/bots`, {
        name: 'SecretKeeper',
        telegramToken: '9876543210:AASecretTokenCheckNothingLeaksHere1234',
        provider: 'openai',
        model: 'gpt-4o-mini',
        apiKey: 'sk-test-key-value-1234567890',
      }),
      ctx(pid),
    );
    expect(bRes.status).toBe(201);
    const text = JSON.stringify(await bRes.json());
    expect(text).not.toContain('AASecretTokenCheckNothingLeaksHere1234');
    expect(text).not.toContain('sk-test-key-value-1234567890');
    // cleanup
    const listRes = await projectBotsRoute.GET(jsonReq(`/api/projects/${pid}/bots`), ctx(pid));
    const listBody = (await listRes.json()) as { bots: Array<{ id: string }> };
    const botId = listBody.bots[0].id;
    await botDetailRoute.DELETE(jsonReq(`/api/bots/${botId}`), ctx(botId));
    await projectDetailRoute.DELETE(jsonReq(`/api/projects/${pid}`), ctx(pid));
  });
});
