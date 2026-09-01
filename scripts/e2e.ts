/**
 * NURAE — REAL end-to-end test driver for the split deployment (Step 14).
 *
 * NO MOCKS, NO STUBS. Everything in this run is real:
 *
 *   real driver (here) → real frontend (Vercel or tunnel) → gateway-link
 *     runtime proxy (optional) → real backend → real api.telegram.org
 *     → real AI provider API
 *
 * The one input that cannot be automated: a Telegram USER must send an
 * actual message to the bot (Telegram forbids bots from messaging first and
 * bots cannot message bots). The workflow run prints the bot's @username and
 * waits — you send the message from any Telegram account — the driver then
 * verifies the FULL round trip through real structured logs:
 *
 *   TELEGRAM_MESSAGE_RECEIVED → AI_REQUEST → AI_RESPONSE → TELEGRAM_MESSAGE_SENT
 *   (and asserts NO AI_REQUEST_FAILED / TELEGRAM_SEND_FAILED / BOT_ERROR)
 *
 * Webhook registration/removal is verified directly against the REAL
 * Telegram API (getWebhookInfo) from this driver — not from the backend's
 * own claims.
 *
 * Configuration:
 *   E2E_BASE_URL              Frontend origin under test (Vercel URL in split
 *                             mode). Default http://127.0.0.1:3000
 *   E2E_WEBHOOK_BASE          Public HTTPS origin of the BACKEND (the tunnel).
 *                             Default: E2E_BASE_URL
 *   E2E_ADMIN_TOKEN           Admin token of the target (enables bearer auth
 *                             and the 401 gate check). Default: open access.
 *   E2E_GATEWAY_LINK          Set to 1 when the frontend runs in gateway mode:
 *                             verifies /api/gateway/status reports THIS tunnel
 *                             as the linked backend before anything else.
 *   E2E_TELEGRAM_TOKEN        REQUIRED. Real bot token. Used by this driver to
 *                             verify getMe/getWebhookInfo directly.
 *   E2E_PROVIDER / E2E_MODEL  Real AI provider id + model (default openai /
 *                             gpt-4o-mini). E2E_AI_API_KEY is the REAL key,
 *                             sent once in the bot-create payload (over HTTPS)
 *                             and stored encrypted at rest — exactly like the
 *                             dashboard does; it is never returned by the API.
 *   E2E_PROVIDER_BASE_URL     Optional base URL (required for provider=custom).
 *   E2E_MESSAGE_WAIT_SECONDS  How long to wait for the human message.
 *                             Default 300.
 *
 * Usage: npx tsx scripts/e2e.ts
 */

const BASE = (process.env.E2E_BASE_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const WEBHOOK_BASE = (process.env.E2E_WEBHOOK_BASE || BASE).replace(/\/+$/, '');
const ADMIN_TOKEN = (process.env.E2E_ADMIN_TOKEN || '').trim();
const TG_TOKEN = (process.env.E2E_TELEGRAM_TOKEN || '').trim();
const PROVIDER = process.env.E2E_PROVIDER || 'openai';
const MODEL = process.env.E2E_MODEL || 'gpt-4o-mini';
const AI_KEY = (process.env.E2E_AI_API_KEY || '').trim();
const PROVIDER_BASE_URL = (process.env.E2E_PROVIDER_BASE_URL || '').trim();
const WAIT_SECONDS = Number(process.env.E2E_MESSAGE_WAIT_SECONDS || 300);

if (!TG_TOKEN) {
  console.error('E2E_TELEGRAM_TOKEN is required (a REAL bot token from @BotFather).');
  process.exit(2);
}
if (!/^https?:\/\//.test(BASE) || !/^https?:\/\//.test(WEBHOOK_BASE)) {
  console.error('E2E_BASE_URL / E2E_WEBHOOK_BASE must be absolute URLs.');
  process.exit(2);
}

console.log(
  `E2E target: ${BASE}${WEBHOOK_BASE !== BASE ? ` (backend/webhooks → ${WEBHOOK_BASE})` : ''} | provider=${PROVIDER}/${MODEL}${PROVIDER_BASE_URL ? ` @ ${PROVIDER_BASE_URL}` : ''} | auth=${ADMIN_TOKEN ? 'bearer' : 'open'} | message wait=${WAIT_SECONDS}s`,
);

interface Step {
  name: string;
  ok: boolean;
  detail?: string;
  ms?: number;
}

const results: Step[] = [];
const step = async (name: string, fn: () => Promise<string | void>) => {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail || undefined, ms: Date.now() - t0 });
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''} (${Date.now() - t0}ms)`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, detail, ms: Date.now() - t0 });
    console.error(`FAIL  ${name} — ${detail}`);
  }
};

function expect(cond: unknown, message: string): void {
  if (!cond) throw new Error(message);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(ADMIN_TOKEN ? { Authorization: `Bearer ${ADMIN_TOKEN}` } : {}),
    },
    ...init,
  });
  const body = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, body };
}

/** Direct REAL Telegram Bot API call (never logs the token or URL). */
async function tg<T>(method: string): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`);
  const body = (await res.json().catch(() => null)) as { ok: boolean; result?: T; error_code?: number; description?: string } | null;
  if (!body?.ok) {
    throw new Error(`real Telegram ${method} failed: ${body?.error_code ?? res.status} ${body?.description ?? 'unknown error'}`);
  }
  return body.result as T;
}

interface TgWebhookInfo {
  url: string;
  pending_update_count: number;
  last_error_message?: string;
}
interface TgMe {
  id: number;
  username?: string;
  first_name: string;
}

interface LogEntry {
  level: string;
  event: string | null;
  message: string;
  timestamp: string;
}

async function fetchLogs(botId: string, limit = 200): Promise<LogEntry[]> {
  const { status, body } = await api<{ logs: LogEntry[] }>(`/api/bots/${botId}/logs?limit=${limit}`);
  expect(status === 200, `logs ${status}`);
  return [...body.logs].sort((a, b) => a.timestamp.localeCompare(b.timestamp)); // oldest → newest
}

let botId = '';
let tgUsername = '';
let startToRunningMs = 0;
let roundTripMs = 0;

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

await step('health endpoint (via frontend → backend chain)', async () => {
  const { status, body } = await api<{ status: string; version: string }>('/api/health');
  expect(status === 200, `health status ${status}`);
  expect(body.version === 'V00.01.000-beta-03', `unexpected version ${body.version}`);
  return body.version;
});

if (ADMIN_TOKEN) {
  await step('auth gate: request without credentials is rejected (401)', async () => {
    const res = await fetch(`${BASE}/api/projects`);
    expect(res.status === 401, `expected 401 without credentials, got ${res.status}`);
    const { body } = await api<{ authRequired: boolean; authenticated: boolean }>('/api/auth/status');
    expect(body.authRequired === true && body.authenticated === true, `auth status ${JSON.stringify(body)}`);
  });
}

if (process.env.E2E_GATEWAY_LINK === '1') {
  await step('gateway link: frontend is linked to THIS backend tunnel', async () => {
    const res = await fetch(`${BASE}/api/gateway/status`);
    expect(res.status === 200, `gateway status ${res.status}`);
    const body = (await res.json()) as { gatewayMode: boolean; linked: boolean; endpoint: string | null };
    expect(body.gatewayMode === true, 'frontend is not in gateway mode (NURAE_GATEWAY_KEY missing on it)');
    expect(body.linked === true, 'frontend has no linked backend yet');
    const tunnelHost = new URL(WEBHOOK_BASE).host;
    expect(body.endpoint === tunnelHost, `linked to ${body.endpoint}, expected ${tunnelHost}`);
    return body.endpoint as string;
  });
}

await step('REAL Telegram getMe (driver → api.telegram.org)', async () => {
  const me = await tg<TgMe>('getMe');
  tgUsername = me.username ? `@${me.username}` : '';
  expect(Boolean(tgUsername), 'bot has no username');
  return tgUsername;
});

await step('create project + bot (real token, real provider)', async () => {
  const p = await api<{ project: { id: string } }>('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: `E2E ${new Date().toISOString().slice(0, 19)}`, description: 'split-deployment E2E' }),
  });
  expect(p.status === 201, `project create ${p.status} ${JSON.stringify(p.body)}`);
  const pid = p.body.project.id;

  const b = await api<{ bot: { id: string } }>(`/api/projects/${pid}/bots`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'E2E Assistant',
      telegramToken: TG_TOKEN,
      provider: PROVIDER,
      model: MODEL,
      ...(AI_KEY ? { apiKey: AI_KEY } : {}),
      ...(PROVIDER_BASE_URL ? { baseUrl: PROVIDER_BASE_URL } : {}),
      systemPrompt: 'You are NURAE E2E, a concise assistant. Answer in at most two short sentences.',
      temperature: 0.5,
      maxTokens: 300,
      memorySize: 6,
    }),
  });
  expect(b.status === 201, `bot create ${b.status} ${JSON.stringify(b.body)}`);
  botId = b.body.bot.id;
  return `bot ${botId}`;
});

await step('start bot → real setWebhook → status RUNNING (webhook)', async () => {
  const t0 = Date.now();
  const r = await api<{ bot: { status: string; transport: string | null } }>(`/api/bots/${botId}/start`, { method: 'POST' });
  startToRunningMs = Date.now() - t0;
  expect(r.status === 200, `start ${r.status} ${JSON.stringify(r.body)}`);
  expect(r.body.bot.status === 'running', `status ${r.body.bot.status}`);
  expect(r.body.bot.transport === 'webhook', `transport ${r.body.bot.transport}`);
  return `${startToRunningMs}ms`;
});

await step('REAL Telegram getWebhookInfo confirms the registered webhook URL', async () => {
  const expected = `${WEBHOOK_BASE}/api/telegram/webhook/${botId}`;
  let info: TgWebhookInfo | null = null;
  for (let i = 0; i < 5; i++) {
    info = await tg<TgWebhookInfo>('getWebhookInfo');
    if (info.url === expected) break;
    await sleep(2000);
  }
  expect(info?.url === expected, `webhook url mismatch: registered="${info?.url}" expected="${expected}"`);
  return info!.url;
});

await step('bot detail matches REAL Telegram identity + leaks no secrets', async () => {
  const { status, body } = await api<{ bot: { telegramUsername: string | null; transport: string | null } }>(`/api/bots/${botId}`);
  expect(status === 200, `bot detail ${status}`);
  expect(body.bot.telegramUsername === tgUsername, `username ${body.bot.telegramUsername} ≠ real ${tgUsername}`);
  expect(body.bot.transport === 'webhook', 'transport not webhook');
  expect(!JSON.stringify(body).includes(TG_TOKEN), 'token leaked in DTO');
});

await step(
  `HUMAN INPUT: waiting for a real Telegram message to ${tgUsername} (up to ${WAIT_SECONDS}s)`,
  async () => {
    console.log('');
    console.log('================================================================');
    console.log(`👉 NOW: open Telegram and send ANY text message to ${tgUsername}`);
    console.log('   (not /start — a plain sentence, e.g. "What is NURAE?")');
    console.log('   Telegram → real webhook → tunnel → backend → real AI → reply');
    console.log('================================================================');
    console.log('');

    const deadline = Date.now() + WAIT_SECONDS * 1000;
    let lastNotice = 0;
    while (Date.now() < deadline) {
      const logs = await fetchLogs(botId);
      const failures = logs.filter((l) => l.event === 'AI_REQUEST_FAILED' || l.event === 'TELEGRAM_SEND_FAILED' || l.event === 'BOT_ERROR');
      if (failures.length > 0) {
        throw new Error(`pipeline failure during wait: ${failures.map((l) => `${l.event}: ${l.message}`).join(' | ')}`);
      }
      // Anchor on the LAST received message so a prior /start welcome does
      // not pollute the timing window or the sequence check.
      const received = [...logs].reverse().find((l) => l.event === 'TELEGRAM_MESSAGE_RECEIVED');
      if (received) {
        const after = logs.filter((l) => l.timestamp >= received.timestamp);
        const aiReq = after.find((l) => l.event === 'AI_REQUEST');
        const aiRes = after.find((l) => l.event === 'AI_RESPONSE');
        const sent = after.filter((l) => l.event === 'TELEGRAM_MESSAGE_SENT');
        if (aiReq && aiRes && sent.length > 0) {
          roundTripMs = Date.parse(sent[sent.length - 1].timestamp) - Date.parse(received.timestamp);
          console.log(`      ${aiReq.message}`);
          console.log(`      ${aiRes.message}`);
          console.log(`      ${sent[sent.length - 1].message}`);
          return `round-trip ≈ ${roundTripMs}ms (receipt → Telegram delivery)`;
        }
      }
      if (Date.now() - lastNotice > 30_000) {
        console.log(`      …still waiting for your message to ${tgUsername} (${Math.round((deadline - Date.now()) / 1000)}s left)`);
        lastNotice = Date.now();
      }
      await sleep(4000);
    }
    const logs = await fetchLogs(botId, 50);
    console.error('      Last logs before timeout:');
    for (const l of logs.slice(-10)) console.error(`      [${l.level}] ${l.event ?? '-'}: ${l.message}`);
    throw new Error(`no real Telegram message round trip within ${WAIT_SECONDS}s. Send a plain text message to ${tgUsername} and re-run.`);
  },
);

await step('structured logs carry Step-9 event codes + no token leak', async () => {
  const logs = await fetchLogs(botId);
  const events = new Set(logs.map((l) => l.event).filter(Boolean));
  for (const event of ['BOT_STARTING', 'BOT_STARTED', 'TELEGRAM_MESSAGE_RECEIVED', 'AI_REQUEST', 'AI_RESPONSE', 'TELEGRAM_MESSAGE_SENT']) {
    expect(events.has(event), `missing ${event} (have: ${[...events].join(', ')})`);
  }
  const leak = logs.some((l) => l.message.includes(TG_TOKEN));
  expect(!leak, 'TELEGRAM TOKEN LEAKED INTO LOGS');
  return `${events.size} distinct events`;
});

await step('stop bot → real deleteWebhook confirmed via getWebhookInfo', async () => {
  const r = await api<{ bot: { status: string } }>(`/api/bots/${botId}/stop`, { method: 'POST' });
  expect(r.status === 200 && r.body.bot.status === 'stopped', `stop ${r.status} ${JSON.stringify(r.body)}`);
  let info: TgWebhookInfo | null = null;
  for (let i = 0; i < 5; i++) {
    info = await tg<TgWebhookInfo>('getWebhookInfo');
    if (!info.url) break;
    await sleep(2000);
  }
  expect(!info?.url, `webhook still registered after stop: "${info?.url}"`);
  return 'webhook removed on Telegram side';
});

await step('invalid token → REAL Telegram 401 → friendly error + ERROR state', async () => {
  const p = await api<{ project: { id: string } }>('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'E2E errors' }),
  });
  expect(p.status === 201, `error project create ${p.status}`);
  // Syntactically valid, deliberately wrong credential — the REAL Telegram
  // API rejects it with 401. This tests the real failure path end to end.
  const b = await api<{ bot: { id: string } }>(`/api/projects/${p.body.project.id}/bots`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Broken',
      telegramToken: '000000000:AARealTelegramWillRejectThisToken0000000',
      provider: PROVIDER,
      model: MODEL,
      ...(PROVIDER_BASE_URL ? { baseUrl: PROVIDER_BASE_URL } : {}),
    }),
  });
  expect(b.status === 201, `broken bot create ${b.status}`);
  const r = await api<{ error?: string }>(`/api/bots/${b.body.bot.id}/start`, { method: 'POST' });
  expect(r.status === 400, `expected 400, got ${r.status}`);
  expect(String((r.body as { error?: string }).error).includes('401'), `error not helpful: ${JSON.stringify(r.body)}`);
  const s = await api<{ status: string; statusDetail: string | null }>(`/api/bots/${b.body.bot.id}/status`);
  expect(s.body.status === 'error', `persisted status ${s.body.status}`);
  expect((s.body.statusDetail ?? '').includes('401'), 'statusDetail missing 401 explanation');
});

await step('cleanup: delete E2E bots and projects', async () => {
  const list = await api<{ projects: Array<{ id: string; name: string }> }>('/api/projects');
  for (const p of list.body.projects.filter((p) => p.name.startsWith('E2E'))) {
    await api(`/api/projects/${p.id}`, { method: 'DELETE' });
  }
});

// ---------------------------------------------------------------------------
// Summary + performance snapshot
// ---------------------------------------------------------------------------

const failed = results.filter((r) => !r.ok);
console.log('\n===== E2E SUMMARY (real services, no mocks) =====');
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ms !== undefined ? ` (${r.ms}ms)` : ''}`);
}
console.log('\n===== PERFORMANCE (real network, single bot) =====');
console.log(`bot start (real getMe + setWebhook): ${startToRunningMs}ms`);
console.log(`real message round trip (receipt → AI → Telegram delivery): ≈${roundTripMs}ms`);
const mem = process.memoryUsage();
console.log(`E2E driver RSS: ${(mem.rss / 1024 / 1024).toFixed(1)}MB`);

if (failed.length > 0) {
  console.error(`\n${failed.length} E2E step(s) FAILED`);
  process.exit(1);
}
console.log('\nALL E2E STEPS PASSED');
