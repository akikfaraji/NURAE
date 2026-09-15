/**
 * NURAE — inline button end-to-end reproduction (Task 28 investigation).
 *
 * Mirrors production 1:1: real Prisma store, real behavior compiler, real
 * TelegramAdapter (JSON bodies) against a recording fake of api.telegram.org,
 * real ingestWebhookUpdate → routeBotUpdate → handleBotCallback.
 *
 * Answers three questions:
 *   1. Does a compiled behavior's welcome message carry reply_markup buttons?
 *   2. Does pressing that button (callback_query) resolve to the rule?
 *   3. Does the pressed button's reply go out (and with what payload)?
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'nurae-repro-'));
process.env.DATABASE_URL = `file:${join(dir, 'repro.db')}`;
process.env.NURAE_SECRET_KEY = 'nurae-repro-secret-key-0123456789abcdef';
process.env.NURAE_ADMIN_TOKEN = '';
process.env.NURAE_BOT_TRANSPORT = '';
process.env.NURAE_PUBLIC_BASE_URL = '';
process.env.OPENAI_API_KEY = '';
process.env.OPENROUTER_API_KEY = '';
process.env.NURAE_TELEGRAM_API_BASE = 'http://127.0.0.1:39999';

// ---- recording fake of the Telegram Bot API -------------------------------
interface Call { method: string; body: Record<string, unknown> }
const calls: Call[] = [];
const REAL_FETCH = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith('http://127.0.0.1:39999/bot')) {
    const m = /\/bot([^/]+)\/(\w+)$/.exec(url);
    const method = m?.[2] ?? '';
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>; } catch { /* ignore */ }
    calls.push({ method, body });
    const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { headers: { 'Content-Type': 'application/json' } });
    if (method === 'getMe') return ok({ id: 42, username: 'repro_bot', first_name: 'Repro' });
    if (method === 'sendMessage') return ok({ message_id: calls.length, chat: { id: body.chat_id } });
    return ok(true);
  }
  return REAL_FETCH(input, init);
}) as typeof fetch;

// ---- schema push ----------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { execSync } = require('node:child_process') as typeof import('node:child_process');
execSync('node node_modules/prisma/build/index.js db push --skip-generate --accept-data-loss', {
  cwd: '/home/z/my-project',
  env: { ...process.env },
  stdio: 'ignore',
});

// ---- the real platform ----------------------------------------------------
async function main() {
  const { db } = await import('../src/lib/db');
  const { compileBehaviors } = await import('../src/lib/nurae/bots/behavior');
  const { serializeCapabilities } = await import('../src/lib/nurae/bots/capabilities');
  const { SecretManager } = await import('../src/lib/nurae/secrets');
  const { ingestWebhookUpdate } = await import('../src/lib/nurae/runtime/transport');

  // A user + a bot with a behavior that has a button (message action), the way
  // the behavior editor + agent + templates all build bots.
  const user = await db.user.create({
    data: { email: 'repro@example.com', name: 'Repro', passwordHash: 'x' },
  });

  const behavior = {
    version: 1 as const,
    behaviors: [
      {
        id: 'welcome',
        title: 'Welcome',
        when: { type: 'start' as const },
        steps: [
          {
            type: 'message' as const,
            text: 'Welcome to the shop!',
            buttons: [
              { label: 'See prices', action: { kind: 'message' as const, text: 'All prices are in the pinned post.' } },
              { label: 'Support', action: { kind: 'link' as const, url: 'https://example.com/support' } },
            ],
          },
        ],
      },
      {
        id: 'flow',
        title: 'Flow',
        when: { type: 'button' as const },
        steps: [{ type: 'message' as const, text: 'You reached the flow.' }],
      },
    ],
  };

  const project = await db.project.create({
    data: { name: 'Repro Project', description: '' },
  });

  const compiled = compileBehaviors(behavior.behaviors as never);
  const caps = serializeCapabilities({ commands: compiled.commands, replies: compiled.replies });
  console.log('--- compiled replies:', JSON.stringify(compiled.replies.map((r) => ({ id: r.id, trigger: r.trigger, buttons: r.messages.map((m) => m.buttons) })), null, 1));

  const bot = await db.bot.create({
    data: {
      name: 'Repro Bot',
      ownerId: user.id,
      projectId: project.id,
      telegramTokenRef: SecretManager.encrypt('123456789:AAReproTokenForLocalReproScript1234'),
      commandsJson: caps.commandsJson,
      repliesJson: caps.repliesJson,
      behaviorsJson: JSON.stringify(behavior),
    },
  });

  // Publish = production webhook start (with a fake public base URL).
  const { startBot } = await import('../src/lib/nurae/runtime/transport');
  const started = await startBot(bot.id, { publicBaseUrl: 'https://repro.example.com' });
  console.log('--- startBot:', started);

  calls.length = 0;

  // 1) Real /start update through the webhook ingestion path.
  await ingestWebhookUpdate(bot.id, {
    update_id: 1,
    message: {
      message_id: 10,
      from: { id: 777, is_bot: false, first_name: 'Tester' },
      chat: { id: 777, type: 'private', first_name: 'Tester' },
      date: Math.floor(Date.now() / 1000),
      text: '/start',
    },
  } as never);

  const sends = calls.filter((c) => c.method === 'sendMessage');
  console.log('--- sendMessage calls after /start:', JSON.stringify(sends, null, 1));

  // Extract the callback of the first inline button Telegram would render.
  const markup = sends[0]?.body?.reply_markup as { inline_keyboard?: Array<Array<{ text: string; callback_data?: string; url?: string }>> } | undefined;
  const pressed = markup?.inline_keyboard?.[0]?.[0];
  console.log('--- first button Telegram shows:', JSON.stringify(pressed));

  if (!pressed?.callback_data) {
    console.log('RESULT: message carried NO callback button — pressing cannot be simulated.');
    await db.$disconnect();
    return;
  }

  // 2) The user taps that button — Telegram POSTs a callback_query.
  calls.length = 0;
  await ingestWebhookUpdate(bot.id, {
    update_id: 2,
    callback_query: {
      id: 'CQ1',
      from: { id: 777, is_bot: false, first_name: 'Tester' },
      message: { message_id: 10, chat: { id: 777, type: 'private' } },
      data: pressed.callback_data,
    },
  } as never);

  console.log('--- calls after button press:', JSON.stringify(calls.filter((c) => c.method !== 'getChatMember'), null, 1));

  await db.$disconnect();
}

main().catch((e) => {
  console.error('REPRO FAILED:', e);
  process.exit(1);
});
