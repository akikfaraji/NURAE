/**
 * NURAE — API route tests (spec §19: create project, create bot, update
 * configuration, start/stop/restart, logs; security: secrets never returned,
 * invalid requests rejected, unauthorized operations rejected).
 *
 * Route handlers are imported directly and invoked with Request objects —
 * no HTTP server needed. The runtime service is stubbed at the fetch level.
 */

import { describe, expect, test, afterAll } from 'bun:test';

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

// Stub the runtime service for lifecycle endpoints.
const REAL_FETCH = globalThis.fetch;
const runtimeCalls: Array<{ path: string; method: string }> = [];
let runtimeMode: 'ok' | 'down' | 'reject-start' = 'ok';
process.env.NURAE_RUNTIME_PORT = '39999';
process.env.NURAE_RUNTIME_TOKEN = 'test-internal-token';

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith('http://127.0.0.1:39999')) {
    const path = url.replace('http://127.0.0.1:39999', '');
    runtimeCalls.push({ path, method: init?.method ?? 'GET' });
    if (runtimeMode === 'down') throw new Error('ECONNREFUSED');
    if (path === '/health') {
      return new Response(JSON.stringify({ name: 'NURAE', version: 'V00.00.000-beta-01', uptimeSec: 1, managedBots: 0 }), {
        status: 200,
      });
    }
    if (path === '/status') {
      return new Response(JSON.stringify({ bots: [] }), { status: 200 });
    }
    const m = /^\/bots\/([^/]+)\/(start|stop|restart|status)$/.exec(path);
    if (m) {
      const [, botId, action] = m;
      if (action === 'status') {
        return new Response(JSON.stringify({ botId, status: 'stopped', startedAt: null }), { status: 200 });
      }
      if (action === 'start' && runtimeMode === 'reject-start') {
        return new Response(JSON.stringify({ error: 'Telegram rejected the bot token (401 Unauthorized).' }), { status: 400 });
      }
      return new Response(JSON.stringify({ botId, status: action === 'stop' ? 'stopped' : 'running' }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
  }
  return REAL_FETCH(input as Request, init);
}) as typeof fetch;

afterAll(async () => {
  globalThis.fetch = REAL_FETCH;
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
    expect(body.version).toBe('V00.00.000-beta-01');
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
    const body = (await res.json()) as { bot: Record<string, unknown>; runtime: { managed: boolean; status: string } };
    expect(body.bot.id).toBe(botId);
    // The stubbed runtime answers the status probe, so the bot counts as managed.
    expect(body.runtime.managed).toBe(true);
    expect(body.runtime.status).toBe('stopped');
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

  test('start / stop / restart proxy to the runtime', async () => {
    runtimeMode = 'ok';
    const start = await botStartRoute.POST(jsonReq(`/api/bots/${botId}/start`, {}), ctx(botId));
    expect(start.status).toBe(200);
    const stop = await botStopRoute.POST(jsonReq(`/api/bots/${botId}/stop`, {}), ctx(botId));
    expect(stop.status).toBe(200);
    const restart = await botRestartRoute.POST(jsonReq(`/api/bots/${botId}/restart`, {}), ctx(botId));
    expect(restart.status).toBe(200);
    expect(runtimeCalls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([
      `/bots/${botId}/start`,
      `/bots/${botId}/stop`,
      `/bots/${botId}/restart`,
    ]);
  });

  test('start failure surfaces a clear error to the client', async () => {
    runtimeMode = 'reject-start';
    const res = await botStartRoute.POST(jsonReq(`/api/bots/${botId}/start`, {}), ctx(botId));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('401');
    runtimeMode = 'ok';
  });

  test('runtime down → 503 with actionable message', async () => {
    runtimeMode = 'down';
    const res = await botStartRoute.POST(jsonReq(`/api/bots/${botId}/start`, {}), ctx(botId));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('runtime');
    runtimeMode = 'ok';
  });

  test('status endpoint merges persisted + runtime state', async () => {
    const res = await botStatusRoute.GET(jsonReq(`/api/bots/${botId}/status`), ctx(botId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { botId: string; persistedStatus: string; runtimeManaged: boolean };
    expect(body.botId).toBe(botId);
    // With the runtime stubbed, the persisted status column never changed:
    // the real runtime would have set it to running on start.
    expect(body.persistedStatus).toBe('stopped');
    expect(body.runtimeManaged).toBe(true);
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
