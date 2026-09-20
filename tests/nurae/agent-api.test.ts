/**
 * NURAE — Remote Agent API tests (Task 4): AgentToken mint/resolve/revoke,
 * /api/v1/me, /api/v1/tools, /api/v1/tools/call (incl. the consequential
 * gating ladder), /api/v1/agent/turn guard rails, /api/mcp (JSON-RPC 2.0),
 * /api/openapi.json, /api/my/tokens and /api/admin/agent-tokens management.
 *
 * Route handlers are imported directly and invoked with Request objects —
 * no HTTP server needed (same pattern as api.test.ts).
 */

import './helpers';
import { describe, expect, test, afterAll } from 'vitest';
import { pushTestSchema } from './helpers';

pushTestSchema();

// With the env set, import the modules under test.
const { db } = await import('../../src/lib/db');
const meRoute = await import('../../src/app/api/v1/me/route');
const v1ToolsRoute = await import('../../src/app/api/v1/tools/route');
const v1CallRoute = await import('../../src/app/api/v1/tools/call/route');
const v1TurnRoute = await import('../../src/app/api/v1/agent/turn/route');
const mcpRoute = await import('../../src/app/api/mcp/route');
const openapiRoute = await import('../../src/app/api/openapi.json/route');
const myTokensRoute = await import('../../src/app/api/my/tokens/route');
const myTokenIdRoute = await import('../../src/app/api/my/tokens/[id]/route');
const adminTokensRoute = await import('../../src/app/api/admin/agent-tokens/route');
const adminTokenIdRoute = await import('../../src/app/api/admin/agent-tokens/[id]/route');
const agentTokens = await import('../../src/lib/nurae/auth/agent-tokens');

afterAll(async () => {
  await db.$disconnect();
});

// ---------------------------------------------------------------------------
// Request builders + fixtures
// ---------------------------------------------------------------------------

const req = (url: string, init?: RequestInit): Request => new Request(`http://localhost:3000${url}`, init);
const bearerReq = (url: string, key: string, init?: RequestInit): Request =>
  req(url, { headers: { authorization: `Bearer ${key}` }, ...init });
const postJson = (url: string, body: unknown, headers: Record<string, string> = {}): Request =>
  req(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
const idCtx = (id: string): { params: Promise<{ id: string }> } => ({ params: Promise.resolve({ id }) });

let userSeq = 0;
async function makeUser(emailVerified = true) {
  userSeq += 1;
  return db.user.create({
    data: {
      email: `agent-api-${userSeq}-${Date.now()}@test.nurae`,
      name: `Agent Owner ${userSeq}`,
      emailVerified,
    },
  });
}

let projectSeq = 0;
async function makeProject() {
  projectSeq += 1;
  return db.project.create({ data: { name: `Agent API project ${projectSeq}-${Date.now()}` } });
}

const mcpPost = (body: unknown, key?: string): Request =>
  postJson('/api/mcp', body, key ? { authorization: `Bearer ${key}` } : {});

// ---------------------------------------------------------------------------
// Token lifecycle
// ---------------------------------------------------------------------------

describe('AgentToken mint → resolve → revoke', () => {
  test('createAgentToken returns the raw key ONCE and stores only the hash', async () => {
    const user = await makeUser();
    const { token, row } = await agentTokens.createAgentToken({
      name: 'Round trip',
      scope: 'user',
      ownerId: user.id,
    });
    expect(token.startsWith('nrae_')).toBe(true);
    expect(token).toHaveLength(48);
    expect(row.prefix).toBe(token.slice(0, 12));
    expect(row.keyHash).toBe(agentTokens.hashAgentKey(token));
    expect(row.keyHash).not.toContain(token.slice(12));
    expect(row.scope).toBe('user');
    expect(row.ownerId).toBe(user.id);
    expect(row.revokedAt).toBeNull();
  });

  test('resolveAgentToken round-trips via the Authorization header', async () => {
    const user = await makeUser();
    const { token, row } = await agentTokens.createAgentToken({
      name: 'Resolver',
      scope: 'user',
      ownerId: user.id,
    });
    const resolved = await agentTokens.resolveAgentToken(bearerReq('/api/v1/me', token));
    expect(resolved?.id).toBe(row.id);
    // Missing / malformed / unknown keys resolve to null.
    expect(await agentTokens.resolveAgentToken(req('/api/v1/me'))).toBeNull();
    expect(await agentTokens.resolveAgentToken(bearerReq('/api/v1/me', `nrae_${'z'.repeat(43)}`))).toBeNull();
    expect(await agentTokens.resolveAgentToken(bearerReq('/api/v1/me', 'not-a-key'))).toBeNull();
  });

  test('revoked tokens resolve to null → /api/v1/me 401', async () => {
    const user = await makeUser();
    const { token, row } = await agentTokens.createAgentToken({
      name: 'Short lived',
      scope: 'user',
      ownerId: user.id,
    });
    expect((await meRoute.GET(bearerReq('/api/v1/me', token))).status).toBe(200);
    await agentTokens.revokeAgentToken(row.id);
    expect(await agentTokens.resolveAgentToken(bearerReq('/api/v1/me', token))).toBeNull();
    const res = await meRoute.GET(bearerReq('/api/v1/me', token));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// /api/v1/me + /api/v1/tools
// ---------------------------------------------------------------------------

describe('GET /api/v1/me and /api/v1/tools', () => {
  test('me reports token identity with the owner email (user scope)', async () => {
    const user = await makeUser();
    const { token } = await agentTokens.createAgentToken({
      name: 'Me probe',
      scope: 'user',
      ownerId: user.id,
      allowConsequential: true,
    });
    const res = await meRoute.GET(bearerReq('/api/v1/me', token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.name).toBe('Me probe');
    expect(body.scope).toBe('user');
    expect(body.allowConsequential).toBe(true);
    expect(body.owner).toEqual({ email: user.email });
    expect(JSON.stringify(body)).not.toContain(token.slice(12));
  });

  test('user scope gets the user tier; platform scope ALSO gets the operator tier', async () => {
    const { token: userToken } = await agentTokens.createAgentToken({
      name: 'Tools user',
      scope: 'user',
      ownerId: (await makeUser()).id,
    });
    const userBody = (await (await v1ToolsRoute.GET(bearerReq('/api/v1/tools', userToken))).json()) as {
      registry: string;
      version: number;
      tools: Array<{ name: string }>;
      skills: unknown[];
      platformTools?: unknown;
    };
    expect(userBody.registry).toBe('nurae.tools');
    expect(userBody.version).toBe(2);
    expect(userBody.tools.length).toBeGreaterThanOrEqual(20);
    expect(userBody.skills.length).toBeGreaterThan(0);
    expect(userBody.platformTools).toBeUndefined();

    const { token: platformToken } = await agentTokens.createAgentToken({
      name: 'Tools operator',
      scope: 'platform',
    });
    const platformBody = (await (await v1ToolsRoute.GET(bearerReq('/api/v1/tools', platformToken))).json()) as {
      tools: Array<{ name: string }>;
      platformTools: Array<{ name: string }>;
      operatorSkills: unknown[];
    };
    expect(platformBody.tools.some((t) => t.name === 'bots_list')).toBe(true);
    expect(platformBody.platformTools.some((t) => t.name === 'platform_overview')).toBe(true);
    expect(platformBody.operatorSkills.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/tools/call — the gating ladder
// ---------------------------------------------------------------------------

describe('POST /api/v1/tools/call', () => {
  test('happy path: bots_list executes with ok:true and zero-arg safety', async () => {
    const user = await makeUser();
    const { token } = await agentTokens.createAgentToken({ name: 'Caller', scope: 'user', ownerId: user.id });
    const res = await v1CallRoute.POST(
      postJson('/api/v1/tools/call', { tool: 'bots_list' }, { authorization: `Bearer ${token}` }),
    );
    // Tool outcomes travel in the body — HTTP stays 200.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; status: string; label: string; data: unknown };
    expect(body.ok).toBe(true);
    expect(body.status).toBe('ok');
    expect(body.label).toContain('Listed 0 bot(s)');
  });

  test('a real write flows through: bot_create_draft then bots_list shows it', async () => {
    const user = await makeUser();
    const { token } = await agentTokens.createAgentToken({ name: 'Builder', scope: 'user', ownerId: user.id });
    const headers = { authorization: `Bearer ${token}` };
    const createRes = await v1CallRoute.POST(
      postJson('/api/v1/tools/call', { tool: 'bot_create_draft', args: { name: 'Remote Draft' } }, headers),
    );
    const createBody = (await createRes.json()) as {
      ok: boolean;
      data: { botId: string; name: string };
    };
    expect(createBody.ok).toBe(true);
    expect(createBody.data.name).toBe('Remote Draft');
    const row = await db.bot.findFirst({ where: { id: createBody.data.botId, ownerId: user.id } });
    expect(row?.name).toBe('Remote Draft');

    const listRes = await v1CallRoute.POST(
      postJson('/api/v1/tools/call', { tool: 'bots_list' }, headers),
    );
    const listBody = (await listRes.json()) as { label: string };
    expect(listBody.label).toContain('Listed 1 bot(s)');
  });

  test('consequential tool WITHOUT confirm → confirm, NOT executed', async () => {
    const user = await makeUser();
    const project = await makeProject();
    const { token } = await agentTokens.createAgentToken({
      name: 'Cautious',
      scope: 'user',
      ownerId: user.id,
      allowConsequential: true,
    });
    const draft = await db.bot.create({
      data: { projectId: project.id, name: 'Gate Bot', ownerId: user.id, systemPrompt: 'x', provider: 'openrouter', model: 'openrouter/free' },
    });
    const res = await v1CallRoute.POST(
      postJson(
        '/api/v1/tools/call',
        { tool: 'bot_publish', args: { botId: draft.id, confirm: false } },
        { authorization: `Bearer ${token}` },
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      status: string;
      confirmRequired: { reason: string; how: string };
    };
    expect(body.status).toBe('confirm');
    expect(body.ok).toBe(false);
    expect(body.confirmRequired.how).toContain('confirm:true');
    const after = await db.bot.findUnique({ where: { id: draft.id } });
    expect(after?.status).toBe(draft.status); // untouched — nothing executed
  });

  test('consequential WITH confirm:true but allowConsequential=false → still confirm, NOT executed', async () => {
    const user = await makeUser();
    const project = await makeProject();
    const { token } = await agentTokens.createAgentToken({
      name: 'No consequences',
      scope: 'user',
      ownerId: user.id,
      allowConsequential: false,
    });
    const draft = await db.bot.create({
      data: { projectId: project.id, name: 'Locked Bot', ownerId: user.id, systemPrompt: 'x', provider: 'openrouter', model: 'openrouter/free' },
    });
    const res = await v1CallRoute.POST(
      postJson(
        '/api/v1/tools/call',
        { tool: 'bot_publish', args: { botId: draft.id, confirm: true }, confirm: true },
        { authorization: `Bearer ${token}` },
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; detail: string };
    expect(body.status).toBe('confirm');
    expect(body.detail).toContain('allowConsequential');
    const after = await db.bot.findUnique({ where: { id: draft.id } });
    expect(after?.enabled).toBe(draft.enabled); // never went live
  });

  test('user-scope token calling a platformRequired tool → honest error outcome', async () => {
    const user = await makeUser();
    const { token } = await agentTokens.createAgentToken({ name: 'Sneaky', scope: 'user', ownerId: user.id });
    const res = await v1CallRoute.POST(
      postJson('/api/v1/tools/call', { tool: 'platform_overview' }, { authorization: `Bearer ${token}` }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; status: string; label: string };
    expect(body.ok).toBe(false);
    expect(body.status).toBe('error');
    expect(body.label).toContain('reserved for the platform operator');
  });

  test('platform-scope token CAN call a platform read tool', async () => {
    const { token } = await agentTokens.createAgentToken({ name: 'Operator eye', scope: 'platform' });
    const res = await v1CallRoute.POST(
      postJson('/api/v1/tools/call', { tool: 'platform_overview' }, { authorization: `Bearer ${token}` }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; status: string; label: string; data: { version: string } };
    expect(body.ok).toBe(true);
    expect(body.status).toBe('ok');
    expect(body.label).toContain('Platform overview');
    expect(body.data.version).toBe('V00.12.000-beta-01');
  });

  test('missing token → 401; bad envelope → 422; unknown tool → honest error outcome', async () => {
    const noAuth = await v1CallRoute.POST(postJson('/api/v1/tools/call', { tool: 'bots_list' }));
    expect(noAuth.status).toBe(401);

    const user = await makeUser();
    const { token } = await agentTokens.createAgentToken({ name: 'Shape check', scope: 'user', ownerId: user.id });
    const bad = await v1CallRoute.POST(
      postJson('/api/v1/tools/call', { nope: true }, { authorization: `Bearer ${token}` }),
    );
    expect(bad.status).toBe(422);

    const unknown = await v1CallRoute.POST(
      postJson('/api/v1/tools/call', { tool: 'totally_not_a_tool' }, { authorization: `Bearer ${token}` }),
    );
    expect(unknown.status).toBe(200);
    const unknownBody = (await unknown.json()) as { ok: boolean; status: string };
    expect(unknownBody.ok).toBe(false);
    expect(unknownBody.status).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// POST /api/v1/agent/turn — guard rails (no AI key in tests: honest 400)
// ---------------------------------------------------------------------------

describe('POST /api/v1/agent/turn', () => {
  test('platform-scope token → 403; unverified owner → 403', async () => {
    const { token: platformToken } = await agentTokens.createAgentToken({ name: 'Turn op', scope: 'platform' });
    const platformRes = await v1TurnRoute.POST(
      postJson('/api/v1/agent/turn', { text: 'build a bot' }, { authorization: `Bearer ${platformToken}` }),
    );
    expect(platformRes.status).toBe(403);

    const unverified = await makeUser(false);
    const { token: unverifiedToken } = await agentTokens.createAgentToken({
      name: 'Turn ghost',
      scope: 'user',
      ownerId: unverified.id,
    });
    const unverifiedRes = await v1TurnRoute.POST(
      postJson('/api/v1/agent/turn', { text: 'build a bot' }, { authorization: `Bearer ${unverifiedToken}` }),
    );
    expect(unverifiedRes.status).toBe(403);
  });

  test('derives or creates the agent session, then reports the AI-layer error honestly', async () => {
    const user = await makeUser();
    const { token } = await agentTokens.createAgentToken({ name: 'Turn driver', scope: 'user', ownerId: user.id });
    const headers = { authorization: `Bearer ${token}` };

    const first = await v1TurnRoute.POST(postJson('/api/v1/agent/turn', { text: 'Build me a shop bot' }, headers));
    expect(first.status).toBe(400);
    const firstBody = (await first.json()) as { sessionId: string; error: string; done: boolean };
    expect(firstBody.sessionId).toBeTruthy();
    expect(firstBody.error).toBeTruthy(); // no AI key configured in tests
    expect(firstBody.done).toBe(false);
    const session = await db.chatSession.findFirst({ where: { id: firstBody.sessionId, userId: user.id, kind: 'agent' } });
    expect(session?.agent).toBe('bot-builder');

    // An explicit sessionId continues THAT session (no duplicate created).
    const second = await v1TurnRoute.POST(
      postJson('/api/v1/agent/turn', { text: 'Continue', sessionId: firstBody.sessionId }, headers),
    );
    expect(second.status).toBe(400);
    const secondBody = (await second.json()) as { sessionId: string };
    expect(secondBody.sessionId).toBe(firstBody.sessionId);
    const count = await db.chatSession.count({ where: { userId: user.id, kind: 'agent' } });
    expect(count).toBe(1);

    // Unknown session → 404.
    const missing = await v1TurnRoute.POST(
      postJson('/api/v1/agent/turn', { text: 'Continue', sessionId: 'does-not-exist' }, headers),
    );
    expect(missing.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /api/mcp — JSON-RPC 2.0
// ---------------------------------------------------------------------------

describe('POST /api/mcp', () => {
  let key = '';

  test('setup: user-scope token', async () => {
    const u = await makeUser();
    const { token } = await agentTokens.createAgentToken({ name: 'MCP client', scope: 'user', ownerId: u.id });
    key = token;
  });

  test('missing Authorization header → 401 + WWW-Authenticate: Bearer + JSON-RPC error', async () => {
    const res = await mcpRoute.POST(postJson('/api/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    const body = (await res.json()) as { jsonrpc: string; id: null; error: { code: number } };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBeNull();
    expect(body.error.code).toBe(-32001);
  });

  test('initialize → protocolVersion + serverInfo; notifications/initialized → 202 empty', async () => {
    const res = await mcpRoute.POST(mcpPost({ jsonrpc: '2.0', id: 1, method: 'initialize' }, key));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      jsonrpc: string;
      id: number;
      result: { protocolVersion: string; capabilities: { tools: object }; serverInfo: { name: string; version: string } };
    };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(1);
    expect(body.result.protocolVersion).toBe('2025-06-18');
    expect(body.result.capabilities.tools).toEqual({});
    expect(body.result.serverInfo.name).toBe('nurae');
    expect(body.result.serverInfo.version).toBe('V00.12.000-beta-01');

    const notif = await mcpRoute.POST(mcpPost({ jsonrpc: '2.0', method: 'notifications/initialized' }, key));
    expect(notif.status).toBe(202);
    expect(await notif.text()).toBe('');
  });

  test('tools/list → MCP-shaped, non-empty; platform scope adds operator tools', async () => {
    const res = await mcpRoute.POST(mcpPost({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, key));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { tools: Array<{ name: string; description: string; inputSchema: object }> } };
    const tools = body.result.tools;
    expect(tools.length).toBeGreaterThanOrEqual(20);
    expect(tools.some((t) => t.name === 'bots_list')).toBe(true);
    for (const t of tools) {
      expect(typeof t.name).toBe('string');
      expect(typeof t.description).toBe('string');
      expect(t.inputSchema).toBeTruthy();
    }

    const { token: platformToken } = await agentTokens.createAgentToken({ name: 'MCP op', scope: 'platform' });
    const platformRes = await mcpRoute.POST(mcpPost({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, platformToken));
    const platformBody = (await platformRes.json()) as { result: { tools: Array<{ name: string }> } };
    expect(platformBody.result.tools.some((t) => t.name === 'platform_overview')).toBe(true);
  });

  test('tools/call executes bots_list through the same gated path', async () => {
    const u = await makeUser();
    const { token } = await agentTokens.createAgentToken({ name: 'MCP caller', scope: 'user', ownerId: u.id });
    const res = await mcpRoute.POST(
      mcpPost({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'bots_list', arguments: {} } }, token),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: number;
      result: { content: Array<{ type: string; text: string }>; isError: boolean };
    };
    expect(body.id).toBe(7);
    expect(body.result.isError).toBe(false);
    expect(body.result.content[0].type).toBe('text');
    const payload = JSON.parse(body.result.content[0].text) as { label: string; status: string };
    expect(payload.label).toContain('Listed 0 bot(s)');
    expect(payload.status).toBe('ok');
  });

  test('unknown method → -32601; bad params → -32602; parse error → -32700; bad envelope → -32600', async () => {
    const unknown = await mcpRoute.POST(mcpPost({ jsonrpc: '2.0', id: 9, method: 'definitely/not/a/method' }, key));
    expect(unknown.status).toBe(200);
    const unknownBody = (await unknown.json()) as { id: number; error: { code: number } };
    expect(unknownBody.id).toBe(9);
    expect(unknownBody.error.code).toBe(-32601);

    const badParams = await mcpRoute.POST(mcpPost({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { arguments: {} } }, key));
    const badParamsBody = (await badParams.json()) as { error: { code: number } };
    expect(badParamsBody.error.code).toBe(-32602);

    const raw = req('/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: '{oops',
    });
    const parseErr = await mcpRoute.POST(raw);
    expect(parseErr.status).toBe(400);
    const parseBody = (await parseErr.json()) as { id: null; error: { code: number } };
    expect(parseBody.id).toBeNull();
    expect(parseBody.error.code).toBe(-32700);

    const badEnvelope = await mcpRoute.POST(mcpPost({ id: 11, method: 'tools/list' }, key));
    const envelopeBody = (await badEnvelope.json()) as { error: { code: number } };
    expect(envelopeBody.error.code).toBe(-32600);
  });

  test('GET /api/mcp → 405 hint', async () => {
    const res = await mcpRoute.GET();
    expect(res.status).toBe(405);
  });
});

// ---------------------------------------------------------------------------
// GET /api/openapi.json
// ---------------------------------------------------------------------------

describe('GET /api/openapi.json', () => {
  test('serves the OpenAPI 3.1 contract with bearerAuth and the v1 paths', async () => {
    const res = await openapiRoute.GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('max-age=300');
    const body = (await res.json()) as {
      openapi: string;
      info: { title: string; version: string };
      servers: Array<{ url: string }>;
      paths: Record<string, unknown>;
      components: { securitySchemes: { bearerAuth: { type: string; scheme: string } } };
    };
    expect(body.openapi).toBe('3.1.0');
    expect(body.info.version).toBe('V00.12.000-beta-01');
    expect(body.servers).toEqual([{ url: '' }]);
    expect(body.paths['/api/v1/tools/call']).toBeTruthy();
    expect(body.paths['/api/v1/agent/turn']).toBeTruthy();
    expect(body.paths['/api/mcp']).toBeTruthy();
    expect(body.components.securitySchemes.bearerAuth.scheme).toBe('bearer');
  });
});

// ---------------------------------------------------------------------------
// Token management (web dashboard surfaces)
// ---------------------------------------------------------------------------

describe('/api/my/tokens', () => {
  test('unauthenticated → 401', async () => {
    expect((await myTokensRoute.GET(req('/api/my/tokens'))).status).toBe(401);
    expect((await myTokensRoute.POST(postJson('/api/my/tokens', { name: 'x' }))).status).toBe(401);
  });

  test('session flow: create returns the raw key once, list shows prefix only, revoke works', async () => {
    const user = await makeUser();
    const sessionToken = `sess-${Date.now()}-${userSeq}`;
    await db.session.create({
      data: { userId: user.id, token: sessionToken, userAgent: 'vitest', expiresAt: new Date(Date.now() + 86400_000) },
    });
    const cookie = { cookie: `nurae_session=${sessionToken}` };

    const createRes = await myTokensRoute.POST(postJson('/api/my/tokens', { name: 'Dashboard key' }, cookie));
    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as {
      token: string;
      tokenMeta: { prefix: string; scope: string; allowConsequential: boolean };
    };
    expect(createBody.token.startsWith('nrae_')).toBe(true);
    expect(createBody.token).toHaveLength(48);
    expect(createBody.tokenMeta.prefix).toBe(createBody.token.slice(0, 12));
    expect(createBody.tokenMeta.scope).toBe('user');
    expect(createBody.tokenMeta.allowConsequential).toBe(false);

    // The key resolves right away.
    const resolved = await agentTokens.resolveAgentToken(bearerReq('/api/v1/me', createBody.token));
    expect(resolved?.ownerId).toBe(user.id);

    const listRes = await myTokensRoute.GET(req('/api/my/tokens', { headers: cookie }));
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { tokens: Array<Record<string, unknown>> };
    const listed = listBody.tokens.find((t) => t.id === resolved?.id);
    expect(listed).toBeTruthy();
    expect(listed?.prefix).toBe(createBody.token.slice(0, 12));
    // The raw key NEVER appears in the list — not even as a fragment.
    expect(JSON.stringify(listBody)).not.toContain(createBody.token);
    expect(JSON.stringify(listBody)).not.toContain(createBody.token.slice(12));
    expect(JSON.stringify(listBody)).not.toContain('keyHash');

    // Revoke via the dashboard → the key dies for the Remote API too.
    const delRes = await myTokenIdRoute.DELETE(req(`/api/my/tokens/${resolved?.id}`, { method: 'DELETE', headers: cookie }), idCtx(resolved!.id));
    expect(delRes.status).toBe(200);
    const delBody = (await delRes.json()) as { ok: boolean; revokedAt: string | null };
    expect(delBody.ok).toBe(true);
    expect(delBody.revokedAt).toBeTruthy();
    expect(await agentTokens.resolveAgentToken(bearerReq('/api/v1/me', createBody.token))).toBeNull();

    // Ownership: another user's token id → 404 (indistinguishable from missing).
    const stranger = await makeUser();
    const strangerSession = `sess-${Date.now()}-stranger`;
    await db.session.create({
      data: { userId: stranger.id, token: strangerSession, userAgent: 'vitest', expiresAt: new Date(Date.now() + 86400_000) },
    });
    const foreignRes = await myTokenIdRoute.DELETE(
      req(`/api/my/tokens/${resolved?.id}`, { method: 'DELETE', headers: { cookie: `nurae_session=${strangerSession}` } }),
      idCtx(resolved!.id),
    );
    expect(foreignRes.status).toBe(404);
  });

  test('platform tokens never appear in a user list; admin surface mints + revokes platform tokens', async () => {
    const user = await makeUser();
    const { row } = await agentTokens.createAgentToken({ name: 'Operator key', scope: 'platform' });

    const sessionToken = `sess-${Date.now()}-adminview`;
    await db.session.create({
      data: { userId: user.id, token: sessionToken, userAgent: 'vitest', expiresAt: new Date(Date.now() + 86400_000) },
    });
    const listBody = (await (
      await myTokensRoute.GET(req('/api/my/tokens', { headers: { cookie: `nurae_session=${sessionToken}` } }))
    ).json()) as { tokens: Array<{ id: string }> };
    expect(listBody.tokens.some((t) => t.id === row.id)).toBe(false);

    // No admin token configured in tests → guard() is open (localhost mode).
    const mint = await adminTokensRoute.POST(postJson('/api/admin/agent-tokens', { name: 'Fleet operator' }));
    expect(mint.status).toBe(201);
    const mintBody = (await mint.json()) as { token: string; tokenMeta: { scope: string; owner: unknown } };
    expect(mintBody.token.startsWith('nrae_')).toBe(true);
    expect(mintBody.tokenMeta.scope).toBe('platform');

    const adminList = await adminTokensRoute.GET(req('/api/admin/agent-tokens'));
    const adminListBody = (await adminList.json()) as { tokens: Array<{ id: string; scope: string }> };
    expect(adminListBody.tokens.some((t) => t.id === row.id)).toBe(true);
    expect(adminListBody.tokens.every((t) => t.scope === 'platform')).toBe(true);

    const revoke = await adminTokenIdRoute.DELETE(req(`/api/admin/agent-tokens/${row.id}`, { method: 'DELETE' }), idCtx(row.id));
    expect(revoke.status).toBe(200);
    const after = await db.agentToken.findUnique({ where: { id: row.id } });
    expect(after?.revokedAt).not.toBeNull();
  });
});
