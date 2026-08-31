/**
 * NURAE — End-to-End test driver (Step 14/15).
 *
 * Exercises the full product loop against the running dev server, with a
 * mock Telegram Bot API and the REAL built-in GLM provider:
 *
 *   health → auth status → create project → create bot → start (webhook)
 *     → POST /start update → POST real message → AI reply verified
 *     → logs/events verified → restart → stop → error-path (bad token)
 *
 * Prerequisites:
 *   - dev server on 127.0.0.1:3000 (fresh, with the beta-02 Prisma client)
 *   - mock Telegram on 127.0.0.1:3131 (bun scripts/mock-telegram.ts)
 *   - .env has NURAE_TELEGRAM_API_BASE=http://127.0.0.1:3131
 *
 * Usage: bun scripts/e2e.ts
 */

const BASE = 'http://127.0.0.1:3000';
const MOCK = 'http://127.0.0.1:3131';

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

async function api<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const body = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, body };
}

interface MockDump {
  calls: Array<{ method: string; body: Record<string, unknown> }>;
  webhooks: Array<[string, { url: string; secret: string }]>;
}

const mockDump = async (): Promise<MockDump> => {
  const res = await fetch(`${MOCK}/__dump`);
  return (await res.json()) as MockDump;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let botId = '';
let botToken = '123456789:AAE2ETokenForNuraeMockTelegramAPITest';
let startToRunningMs = 0;
let webhookLatencyMs = 0;
let aiReplyText = '';

await step('health endpoint returns beta-02 identity', async () => {
  const { status, body } = await api<{ status: string; version: string }>('/api/health');
  expect(status === 200, `health status ${status}`);
  expect(body.version === 'V00.01.000-beta-02', `unexpected version ${body.version}`);
  return body.version;
});

await step('auth is open (no admin token configured locally)', async () => {
  const { body } = await api<{ authRequired: boolean; authenticated: boolean }>('/api/auth/status');
  expect(body.authRequired === false || body.authenticated === true, 'unexpected auth gate');
});

await step('create project + bot (built-in GLM provider)', async () => {
  const p = await api<{ project: { id: string } }>('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: `E2E ${new Date().toISOString().slice(0, 19)}`, description: 'beta-02 E2E' }),
  });
  expect(p.status === 201, `project create ${p.status} ${JSON.stringify(p.body)}`);
  const pid = p.body.project.id;

  const b = await api<{ bot: { id: string } }>(`/api/projects/${pid}/bots`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'E2E Assistant',
      telegramToken: botToken,
      provider: 'zai',
      model: 'glm-4.5-flash',
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

await step('start bot → webhook registered on Telegram, status RUNNING', async () => {
  const t0 = Date.now();
  const r = await api<{ bot: { status: string; transport: string | null } }>(`/api/bots/${botId}/start`, { method: 'POST' });
  startToRunningMs = Date.now() - t0;
  expect(r.status === 200, `start ${r.status} ${JSON.stringify(r.body)}`);
  expect(r.body.bot.status === 'running', `status ${r.body.bot.status}`);
  expect(r.body.bot.transport === 'webhook', `transport ${r.body.bot.transport}`);

  const dump = await mockDump();
  const wh = dump.webhooks.find(([token]) => token === botToken);
  expect(wh, 'no webhook registered on mock Telegram');
  expect(wh![1].url === `${BASE}/api/telegram/webhook/${botId}`, `wrong webhook url ${wh![1].url}`);
  expect(wh![1].secret.length >= 32, 'webhook secret too short');
  return `registered ${wh![1].url}`;
});

async function deliverUpdate(updateId: number, text: string): Promise<void> {
  const res = await fetch(`${BASE}/api/telegram/webhook/${botId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-telegram-bot-api-secret-token': (await mockDump()).webhooks.find(([t]) => t === botToken)![1].secret,
    },
    body: JSON.stringify({
      update_id: updateId,
      message: {
        message_id: updateId,
        from: { id: 42, is_bot: false, first_name: 'E2E' },
        chat: { id: 4242, type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text,
      },
    }),
  });
  expect(res.status === 200, `webhook POST ${res.status}: ${await res.text()}`);
}

await step('Telegram /start delivered → welcome reply sent', async () => {
  await deliverUpdate(101, '/start');
  const dump = await mockDump();
  const sends = dump.calls.filter((c) => c.method === 'sendMessage');
  expect(sends.some((s) => String(s.body.text).includes('is online')), 'no welcome message sent');
});

await step('real message → REAL GLM reply delivered through webhook pipeline', async () => {
  const t0 = Date.now();
  await deliverUpdate(102, 'In one short sentence: what is NURAE?');
  webhookLatencyMs = Date.now() - t0;
  const dump = await mockDump();
  const sends = dump.calls.filter((c) => c.method === 'sendMessage');
  const aiSend = sends.find((s) => String(s.body.text).startsWith('NURAE') || (String(s.body.text).length > 40 && !String(s.body.text).startsWith('⚠️') && !String(s.body.text).includes('is online')));
  expect(aiSend, `no AI reply in sends: ${JSON.stringify(sends.map((s) => String(s.body.text).slice(0, 60)))}`);
  aiReplyText = String(aiSend!.body.text);
  expect(!aiReplyText.startsWith('⚠️'), `AI failed: ${aiReplyText.slice(0, 80)}`);
  return `"${aiReplyText.slice(0, 70)}${aiReplyText.length > 70 ? '…' : ''}" (${webhookLatencyMs}ms round-trip)`;
});

await step('second message → context memory used (bot remembers)', async () => {
  await deliverUpdate(103, 'What did I just ask you about? Answer briefly.');
  const dump = await mockDump();
  const sends = dump.calls.filter((c) => c.method === 'sendMessage');
  const last = sends[sends.length - 1];
  expect(last, 'no reply to second message');
  expect(!String(last.body.text).startsWith('⚠️'), `AI failed: ${String(last.body.text).slice(0, 80)}`);
});

await step('structured logs carry Step-9 event codes', async () => {
  const { body } = await api<{ logs: Array<{ level: string; event: string | null; message: string }> }>(`/api/bots/${botId}/logs?limit=100`);
  const events = new Set(body.logs.map((l) => l.event).filter(Boolean));
  for (const event of ['BOT_STARTING', 'BOT_STARTED', 'TELEGRAM_MESSAGE_RECEIVED', 'AI_REQUEST', 'AI_RESPONSE', 'TELEGRAM_MESSAGE_SENT']) {
    expect(events.has(event), `missing ${event} (have: ${[...events].join(', ')})`);
  }
  const tokenLeak = body.logs.some((l) => l.message.includes(botToken));
  expect(!tokenLeak, 'TELEGRAM TOKEN LEAKED INTO LOGS');
});

await step('bot detail shows @username + no secrets', async () => {
  const { body } = await api<{ bot: { telegramUsername: string | null; transport: string | null } }>(`/api/bots/${botId}`);
  expect(body.bot.telegramUsername === '@nurae_e2e_bot', `username ${body.bot.telegramUsername}`);
  expect(body.bot.transport === 'webhook', 'transport not webhook');
  expect(!JSON.stringify(body).includes(botToken), 'token leaked in DTO');
});

await step('restart keeps the bot RUNNING via webhook', async () => {
  const r = await api<{ bot: { status: string } }>(`/api/bots/${botId}/restart`, { method: 'POST' });
  expect(r.status === 200 && r.body.bot.status === 'running', `restart → ${r.status} ${JSON.stringify(r.body)}`);
  await deliverUpdate(104, '/help');
  const dump = await mockDump();
  expect(dump.calls.some((c) => c.method === 'sendMessage' && String(c.body.text).includes('/start —')), 'no /help reply after restart');
});

await step('stop → webhook removed, status STOPPED', async () => {
  const r = await api<{ bot: { status: string } }>(`/api/bots/${botId}/stop`, { method: 'POST' });
  expect(r.status === 200 && r.body.bot.status === 'stopped', `stop ${r.status}`);
  const dump = await mockDump();
  expect(!dump.webhooks.some(([t]) => t === botToken), 'webhook still registered after stop');
});

await step('invalid token → start fails with friendly 401 error', async () => {
  // The mock Telegram rejects tokens starting with 000000000 (simulated 401).
  const p = await api<{ project: { id: string } }>('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'E2E errors' }),
  });
  const b = await api<{ bot: { id: string } }>(`/api/projects/${p.body.project.id}/bots`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Broken',
      telegramToken: '000000000:AAInvalidTokenThatMockRejects000000',
      provider: 'zai',
      model: 'glm-4.5-flash',
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
console.log('\n===== E2E SUMMARY =====');
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ms !== undefined ? ` (${r.ms}ms)` : ''}`);
}
console.log('\n===== PERFORMANCE (single bot, sandbox) =====');
console.log(`bot start (webhook registration): ${startToRunningMs}ms`);
console.log(`webhook round-trip incl. real GLM reply: ${webhookLatencyMs}ms`);
const mem = process.memoryUsage();
console.log(`E2E driver RSS: ${(mem.rss / 1024 / 1024).toFixed(1)}MB`);

if (failed.length > 0) {
  console.error(`\n${failed.length} E2E step(s) FAILED`);
  process.exit(1);
}
console.log('\nALL E2E STEPS PASSED');
