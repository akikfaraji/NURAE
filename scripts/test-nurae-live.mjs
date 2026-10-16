/**
 * NURAE — LIVE chat + agent test through the platform's own stack,
 * driven by the real OPENROUTER_API_KEY from .env (env fallback path).
 *
 *   Chat : user-login → POST /api/chats → POST /api/chats/:id/messages
 *          → expect a real AI reply (chatTurn → selectProvider → OpenRouter)
 *   Agent: seeded agent token → POST /api/v1/agent/turn (real LLM task)
 *          → expect tool steps + reply → bots_list shows the agent's work
 * Run: node scripts/test-nurae-live.mjs   (server on :3000)
 */
import { readFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:3000';
const CRED = JSON.parse(readFileSync(new URL('../.agent-test-credentials.json', import.meta.url), 'utf8'));
const results = [];
function report(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `\n      ${detail.slice(0, 300)}` : ''}`);
}
async function http(path, { method = 'GET', token, cookie, body, timeout = 180000 } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-json */ }
  return { status: res.status, json, text, headers: res.headers };
}

// ============================================================ 1. CHAT
console.log('\n1. CHAT (user session → chatTurn → OpenRouter)');
let cookie = null;
try {
  const login = await http('/api/auth/user-login', {
    method: 'POST',
    body: { email: CRED.email, password: CRED.password },
    timeout: 20000,
  });
  if (login.status !== 200) throw new Error(`login HTTP ${login.status}: ${login.text.slice(0, 150)}`);
  const raw = login.headers.getSetCookie?.() ?? [login.headers.get('set-cookie')].filter(Boolean);
  cookie = raw.map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error('no session cookie set');
  report('chat: user login + session cookie', true, `cookie: ${cookie.slice(0, 40)}…`);
} catch (e) { report('chat: user login + session cookie', false, String(e.message)); }

let chatId = null;
if (cookie) {
  try {
    const created = await http('/api/chats', { method: 'POST', cookie, body: { kind: 'chat', title: 'Live OpenRouter test' }, timeout: 20000 });
    if (created.status !== 201) throw new Error(`create HTTP ${created.status}: ${created.text.slice(0, 150)}`);
    chatId = created.json?.session?.id;
    if (!chatId) throw new Error(`no session id: ${created.text.slice(0, 150)}`);
    report('chat: session created', true, `chatId=${chatId}`);
  } catch (e) { report('chat: session created', false, String(e.message)); }

  try {
    if (!chatId) throw new Error('skipped (no chat session)');
    const t0 = Date.now();
    const turn = await http(`/api/chats/${chatId}/messages`, {
      method: 'POST', cookie,
      body: { text: 'Reply with exactly: NURAE chat is alive. Then name yourself.' },
    });
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    if (turn.status !== 200) throw new Error(`HTTP ${turn.status}: ${turn.text.slice(0, 250)}`);
    const reply = turn.json?.reply ?? '';
    if (!reply) throw new Error(`empty reply: ${turn.text.slice(0, 250)}`);
    report('chat: REAL AI reply received', true, `${dt}s, handoff=${turn.json?.handoff ? 'yes' : 'no'}\n      reply: ${JSON.stringify(reply.slice(0, 180))}`);
  } catch (e) { report('chat: REAL AI reply received', false, String(e.message)); }

  try {
    if (!chatId) throw new Error('skipped (no chat session)');
    const turn = await http(`/api/chats/${chatId}/messages`, {
      method: 'POST', cookie,
      body: { text: 'What was the exact phrase I asked you to say in my previous message?' },
    });
    const reply = String(turn.json?.reply ?? '');
    if (turn.status !== 200 || !reply) throw new Error(`HTTP ${turn.status}: ${turn.text.slice(0, 200)}`);
    const kept = /alive/i.test(reply);
    report('chat: context retained across turns', kept, `reply: ${reply.slice(0, 160)}`);
  } catch (e) { report('chat: context retained across turns', false, String(e.message)); }
}

// ============================================================ 2. AGENT (remote API, real LLM turns)
console.log('\n2. AGENT (agent token → /api/v1/agent/turn → tools + OpenRouter)');
let sessionId = null;
try {
  const t0 = Date.now();
  const turn = await http('/api/v1/agent/turn', {
    method: 'POST', token: CRED.full,
    body: { text: 'Build me a restaurant bot named "Pizza Live Bot". Give it a /menu command listing Margherita, Pepperoni, Quattro Formaggi. Keep it simple.' },
  });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  if (turn.status !== 200) throw new Error(`HTTP ${turn.status}: ${turn.text.slice(0, 300)}`);
  sessionId = turn.json?.sessionId ?? null;
  const steps = turn.json?.steps?.length ?? 0;
  if (!turn.json?.reply && steps === 0) throw new Error(`empty turn: ${turn.text.slice(0, 300)}`);
  report('agent: real LLM turn executed', true, `${dt}s, sessionId=${sessionId}, steps=${steps}, draftBotId=${turn.json?.draftBotId ?? '-'}\n      reply: ${String(turn.json?.reply ?? '').slice(0, 180)}`);
} catch (e) { report('agent: real LLM turn executed', false, String(e.message)); }

if (sessionId) {
  try {
    const t0 = Date.now();
    const turn = await http('/api/v1/agent/turn', {
      method: 'POST', token: CRED.full,
      body: { text: 'Also add a /hours command that says we are open 9am-9pm every day.', sessionId },
    });
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    if (turn.status !== 200) throw new Error(`HTTP ${turn.status}: ${turn.text.slice(0, 250)}`);
    report('agent: follow-up turn keeps session context', true, `${dt}s, steps=${turn.json?.steps?.length ?? 0}\n      reply: ${String(turn.json?.reply ?? '').slice(0, 160)}`);
  } catch (e) { report('agent: follow-up turn keeps session context', false, String(e.message)); }
}

// ============================================================ 3. agent work visible in DB
console.log('\n3. Agent work persisted');
try {
  const r = await http('/api/v1/tools/call', { method: 'POST', token: CRED.full, body: { tool: 'bots_list', args: {} } });
  const blob = JSON.stringify(r.json);
  const found = /Pizza Live Bot/.test(blob);
  report('agent: created bot visible via bots_list', r.json?.ok === true && found, found ? 'Pizza Live Bot found in inventory' : blob.slice(0, 200));
} catch (e) { report('agent: created bot visible via bots_list', false, String(e.message)); }

// ============================================================ summary
const failed = results.filter((r) => !r.ok);
console.log(`\n${'='.repeat(56)}\nLIVE RESULT: ${results.length - failed.length}/${results.length} passed${failed.length ? ' — FAILURES:' : ''}`);
for (const f of failed) console.log(`  ✗ ${f.name}: ${f.detail.slice(0, 200)}`);
process.exit(failed.length ? 1 : 0);
