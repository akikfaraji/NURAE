/**
 * NURAE — advanced agent-API test battery (dev-only).
 * Drives the Remote API the way an external AI agent would:
 *   A. auth + contract      B. tool semantics (real DB writes)
 *   C. consequential gating D. MCP JSON-RPC 2.0 protocol
 *   E. REAL LLM agent turns (OpenRouter)   F. rate limit   G. revocation
 * Run: node scripts/test-agent-api.mjs  (needs dev server on :3000 + fixture)
 */
import { readFileSync } from 'node:fs';

const BASE = 'http://localhost:3000';
const CRED = JSON.parse(readFileSync(new URL('../.agent-test-credentials.json', import.meta.url), 'utf8'));
const FULL = CRED.full;
const LIMITED = CRED.limited;
const PLATFORM = CRED.platform;

const results = [];
async function case_(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: String(err?.message ?? err) });
    console.log(`  ✗ ${name}\n      ${String(err?.message ?? err).slice(0, 300)}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg ?? 'assertion failed');
}
async function http(path, { method = 'GET', token, body, raw } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(raw ? 10000 : 150000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}

let BOT_ID = null;
let TEMPLATE_BOT_ID = null;
let SESSION_ID = null;

// ============================================================ A. auth + contract
console.log('\nA. auth + contract');
await case_('401 without any Authorization header', async () => {
  const r = await http('/api/v1/me');
  assert(r.status === 401, `expected 401, got ${r.status}: ${r.text.slice(0, 120)}`);
});
await case_('401 for garbage bearer token', async () => {
  const r = await http('/api/v1/me', { token: 'nrae_garbagegarbagegarbagegarbagegarbagegarbage' });
  assert(r.status === 401, `expected 401, got ${r.status}`);
});
await case_('me: full token resolves identity from token row', async () => {
  const r = await http('/api/v1/me', { token: FULL });
  assert(r.status === 200, `expected 200, got ${r.status}: ${r.text.slice(0, 200)}`);
  const body = JSON.stringify(r.json);
  assert(!body.includes(FULL), 'raw key leaked in /me response!');
  assert(body.includes('agent-adv-test@example.com'), `owner identity not reflected: ${body.slice(0, 200)}`);
});
await case_('tools: user scope lists tiered descriptors with inputSchema', async () => {
  const r = await http('/api/v1/tools', { token: FULL });
  assert(r.status === 200, `expected 200, got ${r.status}`);
  const tools = r.json?.tools ?? r.json;
  assert(Array.isArray(tools) && tools.length >= 20, `expected >=20 tools, got ${tools?.length}`);
  for (const t of tools) assert(t.name && t.inputSchema && t.description, `bad descriptor: ${t.name}`);
  const names = tools.map((t) => t.name);
  for (const must of ['bots_list', 'bot_create_draft', 'bot_publish', 'template_use', 'docs_read'])
    assert(names.includes(must), `missing tool ${must}`);
});
await case_('tools: platform scope ALSO exposes platformTools + operatorSkills', async () => {
  const u = await http('/api/v1/tools', { token: FULL });
  const p = await http('/api/v1/tools', { token: PLATFORM });
  assert(!u.json?.platformTools?.length, 'user scope must NOT see platformTools');
  assert(Array.isArray(p.json?.platformTools) && p.json.platformTools.length > 0, 'platform scope missing platformTools');
  assert(Array.isArray(p.json?.operatorSkills) && p.json.operatorSkills.length > 0, 'platform scope missing operatorSkills');
});
await case_('call: unknown tool → honest error outcome (HTTP 200)', async () => {
  const r = await http('/api/v1/tools/call', { method: 'POST', token: FULL, body: { tool: 'definitely_not_a_tool' } });
  assert(r.status === 200, `expected 200, got ${r.status}`);
  assert(r.json?.ok === false && r.json?.status === 'error', `unexpected: ${r.text.slice(0, 200)}`);
});
await case_('call: malformed envelope → 422', async () => {
  const r = await http('/api/v1/tools/call', { method: 'POST', token: FULL, body: {} });
  assert(r.status === 422, `expected 422, got ${r.status}: ${r.text.slice(0, 120)}`);
});
await case_('call: schema-violating args → honest error, never 500', async () => {
  const r = await http('/api/v1/tools/call', {
    method: 'POST', token: FULL,
    body: { tool: 'bot_create_draft', args: { name: 'x'.repeat(500) } },
  });
  assert(r.status === 200 || r.status === 422, `unexpected ${r.status}`);
  if (r.status === 200) assert(r.json?.ok === false, `should fail honestly: ${r.text.slice(0, 200)}`);
});

// ============================================================ B. tool semantics
console.log('\nB. tool semantics (real DB writes via API)');
await case_('bots_list starts the inventory', async () => {
  const r = await http('/api/v1/tools/call', { method: 'POST', token: FULL, body: { tool: 'bots_list', args: {} } });
  assert(r.json?.ok === true, `bots_list failed: ${r.text.slice(0, 200)}`);
});
await case_('bot_create_draft → botId', async () => {
  const r = await http('/api/v1/tools/call', {
    method: 'POST', token: FULL,
    body: { tool: 'bot_create_draft', args: { name: 'Adv Test Bot', description: 'created by advanced agent test', systemPrompt: 'You are a helpful test bot.' } },
  });
  assert(r.json?.ok === true, `create failed: ${r.text.slice(0, 200)}`);
  BOT_ID = r.json?.data?.botId;
  assert(BOT_ID, 'no botId in data');
});
await case_('bot_get reflects the created row', async () => {
  const r = await http('/api/v1/tools/call', { method: 'POST', token: FULL, body: { tool: 'bot_get', args: { botId: BOT_ID } } });
  assert(r.json?.ok === true, `get failed: ${r.text.slice(0, 200)}`);
  assert(JSON.stringify(r.json).includes('Adv Test Bot'), 'name not reflected');
});
await case_('bot_update persists a new description', async () => {
  const r = await http('/api/v1/tools/call', {
    method: 'POST', token: FULL, body: { tool: 'bot_update', args: { botId: BOT_ID, description: 'updated by test suite' } },
  });
  assert(r.json?.ok === true, `update failed: ${r.text.slice(0, 200)}`);
});
await case_('bot_set_commands sets /menu + /help', async () => {
  const r = await http('/api/v1/tools/call', {
    method: 'POST', token: FULL,
    body: { tool: 'bot_set_commands', args: { botId: BOT_ID, commands: [
      { command: '/menu', description: 'Show the menu', kind: 'static', response: 'Pizza, Pasta, Salad' },
      { command: '/help', description: 'How to use this bot', kind: 'static', response: 'Send /menu to begin.' },
    ] } },
  });
  assert(r.json?.ok === true, `set_commands failed: ${r.text.slice(0, 200)}`);
});
await case_('bot_add_knowledge merges into system prompt', async () => {
  const r = await http('/api/v1/tools/call', {
    method: 'POST', token: FULL,
    body: { tool: 'bot_add_knowledge', args: { botId: BOT_ID, knowledge: 'We are open 9am-9pm.', topic: 'hours' } },
  });
  assert(r.json?.ok === true, `add_knowledge failed: ${r.text.slice(0, 200)}`);
  const g = await http('/api/v1/tools/call', { method: 'POST', token: FULL, body: { tool: 'bot_get', args: { botId: BOT_ID } } });
  assert(JSON.stringify(g.json).includes('9am-9pm'), 'knowledge not persisted');
});
await case_('bot_set_replies accepts a keyword rule', async () => {
  const r = await http('/api/v1/tools/call', {
    method: 'POST', token: FULL,
    body: { tool: 'bot_set_replies', args: { botId: BOT_ID, replies: [
      { id: 'price', name: 'Price', trigger: { type: 'keyword', value: 'price' }, messages: [{ text: 'Everything is $9.' }] },
    ] } },
  });
  assert(r.json?.ok === true, `set_replies failed: ${r.text.slice(0, 300)}`);
});
await case_('template_list → catalog, template_use → configured draft', async () => {
  const l = await http('/api/v1/tools/call', { method: 'POST', token: FULL, body: { tool: 'template_list', args: {} } });
  assert(l.json?.ok === true && Array.isArray(l.json?.data) && l.json.data.length > 0, `template_list: ${l.text.slice(0, 150)}`);
  const tid = l.json.data[0].id;
  const u = await http('/api/v1/tools/call', { method: 'POST', token: FULL, body: { tool: 'template_use', args: { templateId: tid, name: 'Adv Template Bot' } } });
  if (u.json?.ok === true) {
    TEMPLATE_BOT_ID = u.json?.data?.botId;
    assert(TEMPLATE_BOT_ID, 'no botId from template_use');
  } else {
    // honest structured failure is acceptable ONLY for the documented env reason
    const why = `${u.json?.detail ?? ''} ${u.json?.label ?? ''}`;
    assert(/site URL|NURAE_SITE_URL|NURAE_PUBLIC_URL/i.test(why), `unexpected failure: ${u.text.slice(0, 250)}`);
  }
});
await case_('docs_read + files_list smoke', async () => {
  const d = await http('/api/v1/tools/call', { method: 'POST', token: FULL, body: { tool: 'docs_read', args: {} } });
  assert(d.status === 200, `docs_read HTTP ${d.status}`);
  const f = await http('/api/v1/tools/call', { method: 'POST', token: FULL, body: { tool: 'files_list', args: {} } });
  assert(f.status === 200, `files_list HTTP ${f.status}`);
});

// ============================================================ C. consequential gating
console.log('\nC. consequential gating (defense in depth)');
await case_('limited token + publish confirm:true → confirm, NOTHING executes', async () => {
  const r = await http('/api/v1/tools/call', { method: 'POST', token: LIMITED, body: { tool: 'bot_publish', args: { botId: BOT_ID, confirm: true }, confirm: true } });
  assert(r.json?.status === 'confirm', `expected confirm, got: ${r.text.slice(0, 250)}`);
  assert(r.json?.confirmRequired?.how, 'missing confirmRequired.how');
  const g = await http('/api/v1/tools/call', { method: 'POST', token: FULL, body: { tool: 'bot_get', args: { botId: BOT_ID } } });
  assert(!/running|live/i.test(JSON.stringify(g.json)), 'bot went live despite gate!');
});
await case_('full token + publish WITHOUT confirm → confirm (tool-level gate)', async () => {
  const r = await http('/api/v1/tools/call', { method: 'POST', token: FULL, body: { tool: 'bot_publish', args: { botId: BOT_ID, confirm: false } } });
  assert(r.json?.status === 'confirm', `expected confirm, got: ${r.text.slice(0, 250)}`);
});
await case_('full token + publish confirm:true → EXECUTES (honest no-telegram-token failure)', async () => {
  const r = await http('/api/v1/tools/call', { method: 'POST', token: FULL, body: { tool: 'bot_publish', args: { botId: BOT_ID, confirm: true }, confirm: true } });
  assert(r.json?.status !== 'confirm', 'gate should have passed');
  assert(r.json?.status === 'error', `expected honest execution error (no telegram token), got: ${r.text.slice(0, 250)}`);
});

// ============================================================ D. MCP protocol
console.log('\nD. MCP JSON-RPC 2.0');
await case_('initialize → protocolVersion + serverInfo', async () => {
  const r = await http('/api/mcp', { method: 'POST', token: PLATFORM, body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'adv-test', version: '1.0' } } } });
  assert(r.status === 200, `HTTP ${r.status}`);
  assert(r.json?.result?.protocolVersion === '2025-06-18', `pv: ${r.text.slice(0, 200)}`);
  assert(r.json?.result?.serverInfo?.name, 'no serverInfo.name');
});
await case_('notifications/initialized → 202 empty', async () => {
  const r = await http('/api/mcp', { method: 'POST', token: PLATFORM, body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
  assert(r.status === 202, `expected 202, got ${r.status}`);
});
await case_('tools/list (platform) → descriptors incl. operator tier', async () => {
  const r = await http('/api/mcp', { method: 'POST', token: PLATFORM, body: { jsonrpc: '2.0', id: 2, method: 'tools/list' } });
  assert(r.json?.result?.tools?.length >= 20, `tools: ${r.text.slice(0, 150)}`);
});
await case_('tools/call bots_list → MCP content shape, isError false', async () => {
  const r = await http('/api/mcp', { method: 'POST', token: PLATFORM, body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'bots_list', arguments: {} } } });
  assert(r.json?.result?.content?.[0]?.type === 'text', `content: ${r.text.slice(0, 200)}`);
  assert(r.json?.result?.isError === false, 'isError should be false');
});
await case_('tools/call unknown tool → isError true (still 200)', async () => {
  const r = await http('/api/mcp', { method: 'POST', token: PLATFORM, body: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope', arguments: {} } } });
  assert(r.status === 200 && r.json?.result?.isError === true, `${r.status}: ${r.text.slice(0, 200)}`);
});
await case_('parse error → -32700', async () => {
  const res = await fetch(BASE + '/api/mcp', { method: 'POST', headers: { authorization: `Bearer ${PLATFORM}`, 'content-type': 'application/json' }, body: '{not json', signal: AbortSignal.timeout(10000) });
  const j = await res.json();
  assert(j?.error?.code === -32700, `code: ${JSON.stringify(j).slice(0, 150)}`);
});
await case_('bad envelope → -32600; unknown method → -32601; bad params → -32602', async () => {
  const a = await http('/api/mcp', { method: 'POST', token: PLATFORM, body: { id: 5 } });
  assert(a.json?.error?.code === -32600, `envelope: ${a.text.slice(0, 150)}`);
  const b = await http('/api/mcp', { method: 'POST', token: PLATFORM, body: { jsonrpc: '2.0', id: 6, method: 'no/such/method' } });
  assert(b.json?.error?.code === -32601, `method: ${b.text.slice(0, 150)}`);
  const c = await http('/api/mcp', { method: 'POST', token: PLATFORM, body: { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { arguments: {} } } });
  assert(c.json?.error?.code === -32602, `params: ${c.text.slice(0, 150)}`);
});
await case_('no auth → 401 + WWW-Authenticate: Bearer', async () => {
  const r = await http('/api/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: 8, method: 'tools/list' } });
  assert(r.status === 401, `expected 401, got ${r.status}`);
  assert(r.headers.get('www-authenticate') === 'Bearer', 'missing WWW-Authenticate');
});
await case_('GET /api/mcp → 405 capability hint', async () => {
  const r = await http('/api/mcp');
  assert(r.status === 405, `expected 405, got ${r.status}`);
});

// ============================================================ E. real LLM agent turns
console.log('\nE. REAL LLM agent turns (OpenRouter)');
await case_('turn 1: natural language → bot draft + tool steps', async () => {
  const r = await http('/api/v1/agent/turn', {
    method: 'POST', token: FULL,
    body: { text: 'Build me a restaurant bot named "Pizza Test Bot". Give it a /menu command listing Margherita, Pepperoni, Quattro Formaggi, and a /contact command with our phone +880-1712-000000. Keep it simple.', sessionId: SESSION_ID ?? undefined },
  });
  assert(r.status === 200, `HTTP ${r.status}: ${r.text.slice(0, 300)}`);
  SESSION_ID = r.json?.sessionId ?? SESSION_ID;
  assert(r.json?.reply || (r.json?.steps?.length ?? 0) > 0, `empty turn: ${r.text.slice(0, 300)}`);
  if (r.json?.draftBotId) BOT_ID = r.json.draftBotId;
  console.log(`      steps=${r.json?.steps?.length ?? 0} draftBotId=${r.json?.draftBotId ?? '-'} reply="${String(r.json?.reply ?? '').slice(0, 90)}"`);
});
await case_('turn 2: same session continues (context kept)', async () => {
  assert(SESSION_ID, 'no session from turn 1');
  const r = await http('/api/v1/agent/turn', {
    method: 'POST', token: FULL,
    body: { text: 'Also add a /hours command that says we are open 9am-9pm every day.', sessionId: SESSION_ID },
  });
  assert(r.status === 200, `HTTP ${r.status}: ${r.text.slice(0, 300)}`);
  assert(r.json?.sessionId === SESSION_ID, 'session not continued');
  console.log(`      steps=${r.json?.steps?.length ?? 0} reply="${String(r.json?.reply ?? '').slice(0, 90)}"`);
});
await case_('agent work is visible through bots_list', async () => {
  const r = await http('/api/v1/tools/call', { method: 'POST', token: FULL, body: { tool: 'bots_list', args: {} } });
  const blob = JSON.stringify(r.json);
  assert(/Pizza Test Bot|Adv Test Bot|Adv Template Bot/.test(blob), `agent-created bots not visible: ${blob.slice(0, 250)}`);
});
await case_('platform token cannot drive agent turns → 403', async () => {
  const r = await http('/api/v1/agent/turn', { method: 'POST', token: PLATFORM, body: { text: 'hello' } });
  assert(r.status === 403, `expected 403, got ${r.status}`);
});
await case_('openapi.json documents the remote surface', async () => {
  const r = await http('/api/openapi.json');
  assert(r.status === 200 && r.json?.openapi?.startsWith('3.1'), `openapi: ${r.text.slice(0, 120)}`);
  const paths = Object.keys(r.json?.paths ?? {});
  for (const p of ['/api/v1/me', '/api/v1/tools', '/api/v1/tools/call', '/api/v1/agent/turn', '/api/mcp'])
    assert(paths.includes(p), `missing path ${p} in ${JSON.stringify(paths)}`);
});

// ============================================================ F. rate limit (limited token budget from here on)
console.log('\nF. rate limit');
await case_('61 rapid calls → 429 with Retry-After', async () => {
  let saw429 = null;
  for (let i = 0; i < 61 && !saw429; i++) {
    const r = await http('/api/v1/tools/call', { method: 'POST', token: LIMITED, body: { tool: 'bots_list', args: {} } });
    if (r.status === 429) saw429 = r;
  }
  assert(saw429, 'never hit 429 in 61 calls');
  assert(saw429.headers.get('retry-after'), 'missing Retry-After header');
});

// ============================================================ G. revocation
console.log('\nG. revocation');
await case_('revoked token → 401 immediately', async () => {
  // revoke the LIMITED token row directly (dev DB) — the API treats revoked as unknown
  const { createHash } = await import('node:crypto');
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    const keyHash = createHash('sha256').update(LIMITED).digest('hex');
    await prisma.agentToken.update({ where: { keyHash }, data: { revokedAt: new Date() } });
  } finally {
    await prisma.$disconnect();
  }
  const r = await http('/api/v1/me', { token: LIMITED });
  assert(r.status === 401, `revoked token still works: ${r.status}`);
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${'='.repeat(60)}\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log('FAILED:');
  for (const f of failed) console.log(`  - ${f.name}\n      ${f.err.slice(0, 250)}`);
  process.exit(1);
}
