/**
 * NURAE — product layer tests (Task 18): bot capabilities, the secure tool
 * layer, the Bot Builder agent, chat sessions + handoff, files/extraction,
 * user-owned bots + test console, and the referral/entitlement system.
 *
 * Same patterns as the platform suite: real route/service code, stubbed
 * fetch (Telegram + AI), isolated per-process SQLite database.
 */

import { describe, expect, test, afterAll } from 'vitest';
import { deflateSync } from 'node:zlib';
import { installTelegramStub, resetTelegramStub, TELEGRAM_STUB_BASE, telegramState } from './telegram-stub';

await import('./helpers');
const { pushTestSchema } = await import('./helpers');
pushTestSchema();

const { db } = await import('../../src/lib/db');
const { SecretManager } = await import('../../src/lib/nurae/secrets');
const { ensureOfficialBot } = await import('../../src/lib/nurae/auth/official-bot');
const {
  hashPassword,
} = await import('../../src/lib/nurae/auth/passwords');
const { createUserSession } = await import('../../src/lib/nurae/auth/sessions');
const { NextResponse } = await import('next/server');

const { serializeCapabilities, loadCapabilities } = await import('../../src/lib/nurae/bots/capabilities');
const { executeTool, toolDescriptors } = await import('../../src/lib/nurae/agents/tools');
const { runBotBuilderTurn, parseAgentReply, ensureAgentSession, addFileRefs } = await import('../../src/lib/nurae/agents/bot-builder');
const {
  createSession,
  chatTurn,
  getSessionWithEntries,
  renameSession,
  setSessionStatus,
  deleteSession,
} = await import('../../src/lib/nurae/chat/sessions');
const { saveUserFile, pickFileContext, extractPdfText, extractDocxText } = await import('../../src/lib/nurae/files');
const {
  createUserBot,
  updateUserBot,
  getUserBot,
  deleteUserBot,
  testBotTextTurn,
  testBotButtonTurn,
  userBotLifecycle,
} = await import('../../src/lib/nurae/bots/user-bots');
const {
  getOrCreateInvite,
  recordReferralSignup,
  qualifyReferralForUser,
  hasEntitlement,
  referralStats,
} = await import('../../src/lib/nurae/referral');
const { handleBotMessage, handleBotCallback, capturingSender } = await import('../../src/lib/nurae/runtime/pipeline');

installTelegramStub();
afterAll(() => {
  resetTelegramStub();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let userCounter = 0;

async function makeUser(email?: string): Promise<{ id: string; email: string; name: string }> {
  userCounter += 1;
  const e = email ?? `t18-${userCounter}-${Date.now()}@example.com`;
  const user = await db.user.create({
    data: { name: `T18 User ${userCounter}`, email: e, passwordHash: await hashPassword('password123'), emailVerified: true },
  });
  return { id: user.id, email: e, name: user.name };
}

/** Point the official platform bot at the stubbed OpenAI-compatible endpoint. */
async function wirePlatformAI(): Promise<void> {
  const botId = await ensureOfficialBot();
  expect(botId).toBeTruthy();
  await db.bot.update({
    where: { id: botId! },
    data: {
      provider: 'custom',
      baseUrl: `${TELEGRAM_STUB_BASE}/v1`,
      apiKeyRef: SecretManager.encrypt('stub-key'),
    },
  });
}

let _store: { createLog: (botId: string | null, level: 'info' | 'warn' | 'error', message: string, event?: string) => Promise<void>; appendUserMessage: (botId: string, chatId: string, content: string) => Promise<void>; appendAssistantMessage: (botId: string, chatId: string, content: string) => Promise<void>; getRecentMessages: (botId: string, chatId: string, limit: number) => Promise<Array<{ role: 'user' | 'assistant' | 'system'; content: string }>>; trimConversation: (botId: string, chatId: string, keep: number) => Promise<void> };
function realStore() {
  return _store;
}
async function runtimeRecord(botId: string) {
  const { createPrismaRuntimeStore } = await import('../../src/lib/nurae/runtime/store');
  _store = createPrismaRuntimeStore(db);
  return _store.getBot(botId);
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

describe('bot capabilities', () => {
  test('round-trips commands and replies through the storage strings', () => {
    const caps = {
      commands: [{ command: '/pricing', description: 'Show pricing', kind: 'static' as const, response: 'All free.' }],
      replies: [
        {
          id: 'r1',
          name: 'Menu',
          trigger: { type: 'command' as const, value: '/menu' },
          messages: [
            {
              text: 'Pick one:',
              buttons: [[{ text: 'Products', callback: 'r:products' }]],
            },
          ],
        },
      ],
    };
    const stored = serializeCapabilities(caps);
    const loaded = loadCapabilities({ commandsJson: stored.commandsJson, repliesJson: stored.repliesJson });
    expect(loaded).toEqual(caps);
  });

  test('rejects unnamespaced button callbacks and oversized command lists', () => {
    expect(() =>
      serializeCapabilities({
        replies: [
          { id: 'x', name: 'Bad', trigger: { type: 'button', value: 'products' }, messages: [{ text: 'hi' }] },
        ],
      }),
    ).toThrow();

    const many = Array.from({ length: 21 }, (_, i) => ({
      command: `/c${i}`,
      description: 'd',
      kind: 'static' as const,
      response: 'r',
    }));
    expect(() => serializeCapabilities({ commands: many })).toThrow();
  });

  test('corrupt JSON degrades to empty capabilities instead of crashing the pipeline', () => {
    const loaded = loadCapabilities({ commandsJson: '{not json', repliesJson: '[broken' });
    expect(loaded).toEqual({ commands: [], replies: [] });
  });
});

// ---------------------------------------------------------------------------
// Tool layer — identity, ownership, confirmation, audit
// ---------------------------------------------------------------------------

describe('agent tool layer', () => {
  test('exposes the registry as JSON-schema descriptors (MCP-compatible surface)', () => {
    const descriptors = toolDescriptors();
    expect(descriptors.length).toBeGreaterThanOrEqual(10);
    const names = descriptors.map((d) => d.name);
    expect(names).toContain('bot_create_draft');
    expect(names).toContain('bot_publish');
    expect(names).toContain('files_read');
    const publish = descriptors.find((d) => d.name === 'bot_publish')!;
    expect(publish.consequential).toBe(true);
    expect(publish.inputSchema).toHaveProperty('properties');
  });

  test('bot_create_draft creates an owned bot and writes the audit trail', async () => {
    const owner = await makeUser();
    const { chatSession: session } = { chatSession: await db.chatSession.create({ data: { userId: owner.id, kind: 'agent', agent: 'bot-builder' } }) };
    const ctx = { userId: owner.id, sessionId: session.id };

    const rec = await executeTool(
      ctx,
      'bot_create_draft',
      {
        name: 'Shop Bot',
        description: 'Answers customers',
        behaviors: [
          { id: 'hi', title: 'Say hi', when: { type: 'command', command: '/hi' }, steps: [{ type: 'message', text: 'Hello!' }] },
        ],
      },
      1,
    );
    expect(rec.status).toBe('ok');

    const bot = await db.bot.findFirst({ where: { ownerId: owner.id } });
    expect(bot?.name).toBe('Shop Bot');
    // The behavior compiled into the executed menu command.
    expect(bot?.commandsJson).toContain('/hi');

    // Audit: one AgentStep + one sanitized platform Log row.
    const steps = await db.agentStep.findMany({ where: { sessionId: session.id } });
    expect(steps).toHaveLength(1);
    expect(steps[0].tool).toBe('bot_create_draft');
    const logs = await db.log.findMany({ where: { event: 'AGENT_TOOL' }, orderBy: { timestamp: 'desc' }, take: 1 });
    expect(logs[0].message).toContain('bot_create_draft');
  });

  test('cross-user access is impossible: user B cannot read, update, or publish user A\u2019s bot', async () => {
    const owner = await makeUser();
    const attacker = await makeUser();
    const created = await createUserBot(owner.id, { name: 'Private Bot' });
    expect(created.bot).toBeTruthy();

    const session = await db.chatSession.create({ data: { userId: attacker.id, kind: 'agent', agent: 'bot-builder' } });
    const attackerCtx = { userId: attacker.id, sessionId: session.id };

    const get = await executeTool(attackerCtx, 'bot_get', { botId: created.bot!.id }, 1);
    expect(get.status).toBe('error');
    expect(get.label).toMatch(/not found|not yours/i);

    const upd = await executeTool(attackerCtx, 'bot_update', { botId: created.bot!.id, name: 'Hijacked' }, 2);
    expect(upd.status).toBe('error');

    const pub = await executeTool(attackerCtx, 'bot_publish', { botId: created.bot!.id, confirm: true }, 3);
    expect(pub.status).toBe('error');
    const row = await db.bot.findUnique({ where: { id: created.bot!.id } });
    expect(row?.status).toBe('stopped'); // untouched
  });

  test('bot_publish waits for the user\u2019s approval even when the model says confirm:true', async () => {
    const owner = await makeUser();
    const created = await createUserBot(owner.id, { name: 'Needs Approval', telegramToken: '1234567890:AAValidFormatTokenForTesting1234' });
    const session = await db.chatSession.create({ data: { userId: owner.id, kind: 'agent', agent: 'bot-builder' } });

    // Model says confirm:true but the user has NOT approved (ctx.userConfirmed unset).
    const unconfirmed = await executeTool(
      { userId: owner.id, sessionId: session.id },
      'bot_publish',
      { botId: created.bot!.id, confirm: true },
      1,
    );
    expect(unconfirmed.status).toBe('confirm');

    // User approved this turn → proceeds (webhook start through the Telegram stub).
    process.env.NURAE_PUBLIC_BASE_URL = 'https://stub.example.com';
    const confirmed = await executeTool(
      { userId: owner.id, sessionId: session.id, userConfirmed: true },
      'bot_publish',
      { botId: created.bot!.id, confirm: true },
      2,
    );
    expect(confirmed.status).toBe('ok');
    const row = await db.bot.findUnique({ where: { id: created.bot!.id } });
    expect(row?.status).toBe('running');
    process.env.NURAE_PUBLIC_BASE_URL = '';
  });

  test('argument validation rejects garbage before anything executes', async () => {
    const owner = await makeUser();
    const session = await db.chatSession.create({ data: { userId: owner.id, kind: 'agent', agent: 'bot-builder' } });
    const rec = await executeTool({ userId: owner.id, sessionId: session.id }, 'bot_create_draft', { name: 42 }, 1);
    expect(rec.status).toBe('error');
    expect(await db.bot.count({ where: { ownerId: owner.id } })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Bot Builder agent
// ---------------------------------------------------------------------------

describe('bot builder agent', () => {
  test('parses the JSON envelope leniently (prose around it tolerated)', () => {
    const parsed = parseAgentReply('Here is what I will do:\n{"message":"Building it now","actions":[{"tool":"bots_list","args":{}}],"done":false}');
    expect(parsed.jsonOk).toBe(true);
    expect(parsed.actions).toHaveLength(1);
    expect(parsed.message).toBe('Building it now');

    const plain = parseAgentReply('I will just explain things instead.');
    expect(plain.jsonOk).toBe(false);
    expect(plain.done).toBe(true);
    expect(plain.actions).toHaveLength(0);
  });

  test('a full turn: the model drafts a bot through tools and the activity feed records it', async () => {
    await wirePlatformAI();
    const owner = await makeUser();
    const sessionId = await ensureAgentSession(owner.id, { agent: 'bot-builder', title: 'Shop bot' });

    // Model output (scripted): create a draft, then set commands.
    telegramState.aiResponses.push(
      JSON.stringify({
        message: 'Creating your bot.',
        actions: [
          {
            tool: 'bot_create_draft',
            args: { name: 'Clothing Store Bot', description: 'Answers product questions' },
          },
        ],
        done: false,
      }),
    );
    telegramState.aiResponses.push(
      JSON.stringify({
        message: 'Draft ready — I added the commands. Say the word to publish.',
        actions: [],
        done: true,
      }),
    );

    const result = await runBotBuilderTurn({ userId: owner.id, sessionId, userText: 'Make me a clothing store bot' });
    expect(result.error).toBeUndefined();
    expect(result.reply).toContain('Draft ready');
    expect(result.activity.length).toBe(1);
    expect(result.activity[0].status).toBe('ok');
    expect(result.draftBotId).toBeTruthy();

    const bot = await db.bot.findFirst({ where: { ownerId: owner.id } });
    expect(bot?.name).toBe('Clothing Store Bot');

    // Session state persists the draft id; entries + steps are durable.
    const session = await db.chatSession.findUnique({ where: { id: sessionId } });
    expect(JSON.parse(session!.state ?? '{}').draftBotId).toBe(result.draftBotId);
    const entries = await db.chatEntry.findMany({ where: { sessionId } });
    expect(entries.some((e) => e.role === 'assistant' && e.content.includes('Draft ready'))).toBe(true);
  });

  test('invalid model output degrades to a plain message — no crash, no actions', async () => {
    await wirePlatformAI();
    const owner = await makeUser();
    const sessionId = await ensureAgentSession(owner.id, { agent: 'bot-builder' });
    telegramState.aiResponses.push('I cannot do that right now, sorry.');
    const result = await runBotBuilderTurn({ userId: owner.id, sessionId, userText: 'do something odd' });
    expect(result.reply).toContain('cannot do that');
    expect(result.activity).toHaveLength(0);
    expect(await db.bot.count({ where: { ownerId: owner.id } })).toBe(0);
  });

  test('another user\u2019s agent session is invisible (404-style error)', async () => {
    await wirePlatformAI();
    const owner = await makeUser();
    const attacker = await makeUser();
    const sessionId = await ensureAgentSession(owner.id, { agent: 'bot-builder' });
    const result = await runBotBuilderTurn({ userId: attacker.id, sessionId, userText: 'let me in' });
    expect(result.error).toMatch(/not found/i);
  });

  test('agent attachments join the session fileRefs and files_list sees chat-attached files', async () => {
    await wirePlatformAI();
    const { saveUserFile } = await import('../../src/lib/nurae/files');
    const { executeTool } = await import('../../src/lib/nurae/agents/tools');
    const owner = await makeUser();
    const sessionId = await ensureAgentSession(owner.id, { agent: 'bot-builder' });

    // A file uploaded in the ORIGINATING chat (different session id) travels
    // with the handoff via state fileRefs…
    const chatFile = await saveUserFile({
      userId: owner.id,
      sessionId: null,
      name: 'chat-price-list.txt',
      mime: 'text/plain',
      bytes: Buffer.from('T-shirt 12$\nHoodie 24$'),
    });
    await addFileRefs(sessionId, [{ fileId: chatFile.id, name: chatFile.name }]);

    // …and a file attached directly to the AGENT turn is merged into state too.
    const agentFile = await saveUserFile({
      userId: owner.id,
      sessionId,
      name: 'agent-notes.txt',
      mime: 'text/plain',
      bytes: Buffer.from('Free shipping over 50$'),
    });
    telegramState.aiResponses.push(JSON.stringify({ message: 'Noted.', actions: [], done: true }));
    const result = await runBotBuilderTurn({
      userId: owner.id,
      sessionId,
      userText: 'Use my price list',
      attachmentIds: [agentFile.id],
    });
    expect(result.error).toBeUndefined();

    const session = await db.chatSession.findUnique({ where: { id: sessionId } });
    const state = JSON.parse(session!.state ?? '{}') as { fileRefs?: Array<{ name: string }> };
    expect(state.fileRefs?.map((f) => f.name)).toContain('chat-price-list.txt');
    expect(state.fileRefs?.map((f) => f.name)).toContain('agent-notes.txt');

    // files_list (the agent's door to files) sees BOTH — audited via AgentStep.
    const listed = await executeTool({ userId: owner.id, sessionId }, 'files_list', {}, 1);
    expect(listed.status).toBe('ok');
    const stepRow = await db.agentStep.findFirst({ where: { sessionId, seq: 1 }, orderBy: { seq: 'desc' } });
    expect(stepRow).toBeTruthy();
    const data = JSON.parse(stepRow!.resultJson ?? '[]') as Array<{ id: string }>;
    expect(data.map((f) => f.id)).toContain(chatFile.id);
    expect(data.map((f) => f.id)).toContain(agentFile.id);

    // Foreign attachment ids are dropped silently (chat rule, same here).
    const attacker = await makeUser();
    const foreign = await saveUserFile({
      userId: attacker.id,
      sessionId: null,
      name: 'foreign.txt',
      mime: 'text/plain',
      bytes: Buffer.from('nope'),
    });
    telegramState.aiResponses.push(JSON.stringify({ message: 'Ok.', actions: [], done: true }));
    await runBotBuilderTurn({ userId: owner.id, sessionId, userText: 'again', attachmentIds: [foreign.id] });
    const sessionAfter = await db.chatSession.findUnique({ where: { id: sessionId } });
    const stateAfter = JSON.parse(sessionAfter!.state ?? '{}') as { fileRefs?: Array<{ name: string }> };
    expect(stateAfter.fileRefs?.map((f) => f.name)).not.toContain('foreign.txt');
  });

  test('approval-only turn writes no empty user entry', async () => {
    await wirePlatformAI();
    const owner = await makeUser();
    const sessionId = await ensureAgentSession(owner.id, { agent: 'bot-builder' });
    telegramState.aiResponses.push(JSON.stringify({ message: 'Published where approved.', actions: [], done: true }));
    const result = await runBotBuilderTurn({ userId: owner.id, sessionId, userText: '', userConfirmed: true });
    expect(result.error).toBeUndefined();
    const userEntries = await db.chatEntry.findMany({ where: { sessionId, role: 'user' } });
    expect(userEntries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Chat sessions + handoff
// ---------------------------------------------------------------------------

describe('chat sessions', () => {
  test('create / rename / archive / delete with ownership enforced', async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const s = await createSession(owner.id, { title: 'My chat' });
    expect(s.title).toBe('My chat');

    expect(await renameSession(stranger.id, s.id, 'hijacked')).toBeNull();
    expect(await renameSession(owner.id, s.id, 'Renamed')).toBeTruthy();
    expect(await setSessionStatus(owner.id, s.id, 'archived')).toBeTruthy();
    expect(await deleteSession(stranger.id, s.id)).toBe(false);
    expect(await deleteSession(owner.id, s.id)).toBe(true);
  });

  test('chatTurn answers through the platform AI and persists both turns', async () => {
    await wirePlatformAI();
    const owner = await makeUser();
    const s = await createSession(owner.id, {});
    const r = await chatTurn({ userId: owner.id, sessionId: s.id, text: 'What is NURAE?' });
    expect(r.reply).toBe('stubbed AI reply');
    expect(r.handoff).toBeNull();

    const loaded = await getSessionWithEntries(owner.id, s.id);
    expect(loaded!.entries.map((e) => e.role)).toEqual(['user', 'assistant']);
  });

  test('build requests are handed to the Bot Builder agent with files by reference', async () => {
    await wirePlatformAI();
    const owner = await makeUser();
    const file = await saveUserFile({
      userId: owner.id,
      sessionId: null,
      name: 'menu.txt',
      mime: 'text/plain',
      bytes: Buffer.from('Pizza 8$\nPasta 10$'),
    });

    const s = await createSession(owner.id, {});
    // Scripted: the chat model emits the handoff directive; the agent loop
    // then answers (one round) and stops.
    telegramState.aiResponses.push(
      'I can have the Bot Builder agent build this using your document.\n{"handoff":"bot-builder","task":"Build a restaurant menu bot from the attached menu"}',
    );
    telegramState.aiResponses.push(
      JSON.stringify({ message: 'On it — I will draft the bot next.', actions: [], done: true }),
    );

    const r = await chatTurn({
      userId: owner.id,
      sessionId: s.id,
      text: 'Make me a Telegram bot using this.',
      attachmentIds: [file.id],
    });
    expect(r.handoff?.agent).toBe('bot-builder');
    expect(r.handoff!.sessionId).toBeTruthy();

    // The agent session received the task ONCE (as the first user entry —
    // no duplicate system copy) and the file reference travels in state.
    const agentSession = await db.chatSession.findUnique({ where: { id: r.handoff!.sessionId } });
    expect(agentSession?.kind).toBe('agent');
    const agentEntries = await db.chatEntry.findMany({ where: { sessionId: agentSession!.id } });
    const systemEntries = agentEntries.filter((e) => e.role === 'system');
    expect(systemEntries).toHaveLength(0);
    const userEntries = agentEntries.filter((e) => e.role === 'user');
    expect(userEntries).toHaveLength(1);
    expect(userEntries[0].content).toContain('Make me a Telegram bot');
    const agentState = JSON.parse(agentSession!.state ?? '{}') as { fileRefs?: Array<{ name: string }> };
    expect(agentState.fileRefs?.some((f) => f.name === 'menu.txt')).toBe(true);

    // The chat shows the reply + a handoff card.
    const loaded = await getSessionWithEntries(owner.id, s.id);
    const assistant = loaded!.entries.find((e) => e.role === 'assistant');
    expect(assistant?.handoff?.sessionId).toBe(r.handoff!.sessionId);
  });

  test('a second handoff CONTINUES the existing agent session', async () => {
    await wirePlatformAI();
    const owner = await makeUser();
    const s = await createSession(owner.id, {});
    // First handoff creates the session; the agent loop answers and stops.
    telegramState.aiResponses.push(
      'Let me take that on.\n{"handoff":"bot-builder","task":"Build a restaurant bot"}',
    );
    telegramState.aiResponses.push(
      JSON.stringify({ message: 'Drafted.', actions: [], done: true }),
    );
    const first = await chatTurn({ userId: owner.id, sessionId: s.id, text: 'Build me a restaurant bot' });
    expect(first.handoff?.sessionId).toBeTruthy();

    // Second handoff: same user, later request → the SAME agent session is
    // continued (no parallel workspace, no forked draft state).
    telegramState.aiResponses.push(
      'On it.\n{"handoff":"bot-builder","task":"Add a contact button"}',
    );
    telegramState.aiResponses.push(
      JSON.stringify({ message: 'Added.', actions: [], done: true }),
    );
    const second = await chatTurn({ userId: owner.id, sessionId: s.id, text: 'Add a contact button' });
    expect(second.handoff?.sessionId).toBe(first.handoff!.sessionId);
    const turns = await db.chatEntry.findMany({ where: { sessionId: first.handoff!.sessionId, role: 'user' } });
    expect(turns.map((t) => t.content)).toContain('Add a contact button');
  });

  test('attachment ids from another user are silently dropped', async () => {
    await wirePlatformAI();
    const owner = await makeUser();
    const attacker = await makeUser();
    const foreignFile = await saveUserFile({ userId: attacker.id, sessionId: null, name: 'secret.txt', mime: 'text/plain', bytes: Buffer.from('top secret') });
    const s = await createSession(owner.id, {});
    const r = await chatTurn({ userId: owner.id, sessionId: s.id, text: 'check this file', attachmentIds: [foreignFile.id] });
    expect(r.reply).toBe('stubbed AI reply');
    const loaded = await getSessionWithEntries(owner.id, s.id);
    const userEntry = loaded!.entries.find((e) => e.role === 'user');
    expect(userEntry?.attachments).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

describe('files + extraction', () => {
  test('plain text and CSV extract directly; image files report binary honestly', async () => {
    const user = await makeUser();
    const text = await saveUserFile({ userId: user.id, sessionId: null, name: 'notes.md', mime: 'text/markdown', bytes: Buffer.from('# Notes\n\nSome text') });
    expect(text.status).toBe('ready');
    expect(text.hasText).toBe(true);

    const csv = await saveUserFile({ userId: user.id, sessionId: null, name: 'products.csv', mime: 'text/csv', bytes: Buffer.from('name,price\nPizza,8') });
    expect(csv.kind).toBe('csv');

    // 8-byte PNG header as a stand-in binary image.
    const img = await saveUserFile({ userId: user.id, sessionId: null, name: 'logo.png', mime: 'image/png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) });
    expect(img.status).toBe('binary');
    expect(img.hasText).toBe(false);
  });

  test('PDF extraction reads uncompressed text operators', () => {
    const pdf = Buffer.from(
      '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nstream\nBT /F1 12 Tf (Welcome to NURAE) Tj ( menu line two) Tj ET\nendstream\nendobj\n%%EOF',
      'latin1',
    );
    const text = extractPdfText(pdf);
    expect(text).toContain('Welcome to NURAE');
    expect(text).toContain('menu line two');
  });

  test('PDF extraction reads zlib-compressed streams', () => {
    const content = 'BT (Compressed menu item) Tj ET';
    const compressed = deflateSync(Buffer.from(content, 'latin1'));
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.4\nstream\n', 'latin1'),
      compressed,
      Buffer.from('\nendstream\n%%EOF', 'latin1'),
    ]);
    expect(extractPdfText(pdf)).toContain('Compressed menu item');
  });

  test('DOCX extraction inflates word/document.xml and reads paragraphs', () => {
    // Hand-build a minimal stored (method 0) ZIP with one entry.
    const xml = Buffer.from(
      '<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:t>Menu heading</w:t></w:p><w:p><w:t>Pizza &amp; Pasta</w:t></w:p></w:body></w:document>',
      'utf8',
    );
    const name = Buffer.from('word/document.xml', 'utf8');
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(0, 8); // method: stored
    header.writeUInt32LE(xml.length, 18); // compressed size
    header.writeUInt32LE(xml.length, 22); // uncompressed size
    header.writeUInt16LE(name.length, 26);
    const zip = Buffer.concat([header, name, xml]);
    const text = extractDocxText(zip);
    expect(text).toContain('Menu heading');
    expect(text).toContain('Pizza & Pasta');
  });

  test('pickFileContext: head+tail slices with ownership checks and a hard cap', async () => {
    const user = await makeUser();
    const big = 'A'.repeat(20000) + 'MIDDLE-RARE-TOKEN' + 'B'.repeat(20000);
    const f1 = await saveUserFile({ userId: user.id, sessionId: null, name: 'big.txt', mime: 'text/plain', bytes: Buffer.from(big) });
    const ctx = await pickFileContext(user.id, [{ fileId: f1.id, name: 'big.txt', kind: 'text' }], { perFileChars: 2000, totalChars: 3000 });
    expect(ctx).toContain('big.txt');
    expect(ctx).toContain('middle omitted');
    expect(ctx.length).toBeLessThan(3400);

    // A file id from ANOTHER user never enters the context.
    const stranger = await makeUser();
    const empty = await pickFileContext(stranger.id, [{ fileId: f1.id, name: 'big.txt', kind: 'text' }]);
    expect(empty).toBe('');
  });
});

// ---------------------------------------------------------------------------
// User bots + test console
// ---------------------------------------------------------------------------

describe('user-owned bots', () => {
  test('draft-friendly creation (no token) with capabilities; lifecycle refuses to start without a token', async () => {
    const owner = await makeUser();
    const created = await createUserBot(owner.id, {
      name: 'Draft Bot',
      commands: [{ command: '/start2', description: 'second start', kind: 'static', response: 'hey' }],
    });
    expect(created.bot?.hasTelegramToken).toBe(false);
    expect(created.bot?.commands).toHaveLength(1);

    const lifecycle = await userBotLifecycle(owner.id, created.bot!.id, 'start', null);
    expect(lifecycle.ok).toBe(false);
    expect(lifecycle.error).toMatch(/no telegram token/i);

    expect(await getUserBot(owner.id, created.bot!.id)).toBeTruthy();
    expect(await deleteUserBot(owner.id, created.bot!.id)).toBe(true);
  });

  test('token format validation still applies when a token is given', async () => {
    const owner = await makeUser();
    const bad = await createUserBot(owner.id, { name: 'Bad Token', telegramToken: 'not-a-token' });
    expect(bad.error).toMatch(/Validation failed/);
    expect(bad.fields?.telegramToken).toBeTruthy();
  });

  test('test console runs the REAL pipeline: custom commands, buttons, and AI turns', async () => {
    const owner = await makeUser();
    const created = await createUserBot(owner.id, {
      name: 'Console Bot',
      telegramToken: '1234567890:AAValidFormatTokenForTesting1234',
      commands: [{ command: '/prices', description: 'Prices', kind: 'static', response: '**All free** right now.' }],
      replies: [
        {
          id: 'r1',
          name: 'Contact',
          trigger: { type: 'keyword', value: 'contact' },
          messages: [{ text: 'Reach us here:', buttons: [[{ text: 'Website', url: 'https://example.com' }, { text: 'More', callback: 'r:more' }]] }],
        },
        {
          id: 'r2',
          name: 'More',
          trigger: { type: 'button', value: 'r:more' },
          messages: [{ text: 'More details arrive.' }, { text: 'Second workflow step.' }],
        },
      ],
    });
    const botId = created.bot!.id;

    // Custom static command.
    const cmd = await testBotTextTurn(owner.id, botId, '/prices');
    expect(cmd.sends).toHaveLength(1);
    expect(cmd.sends[0].parseMode).toBe('HTML');
    expect(cmd.sends[0].text).toContain('<b>All free</b>');

    // Keyword trigger with buttons (first message carries the keyboard).
    const kw = await testBotTextTurn(owner.id, botId, 'how can I contact you?');
    expect(kw.sends).toHaveLength(1);
    expect(kw.sends[0].buttons?.[0][0].url).toBe('https://example.com');
    expect(kw.sends[0].buttons?.[0][1].callback).toBe('r:more');

    // Button press → two-message workflow.
    const cb = await testBotButtonTurn(owner.id, botId, 'r:more');
    expect(cb.sends).toHaveLength(2);
    expect(cb.sends[1].text).toContain('Second workflow step');

    // AI turn (bot points at the stub provider).
    await db.bot.update({
      where: { id: botId },
      data: { provider: 'custom', baseUrl: `${TELEGRAM_STUB_BASE}/v1`, apiKeyRef: SecretManager.encrypt('stub-key') },
    });
    const ai = await testBotTextTurn(owner.id, botId, 'Tell me a joke');
    expect(ai.sends).toHaveLength(1);
    expect(ai.sends[0].text).toContain('stubbed AI reply');

    // Another owner gets nothing.
    const stranger = await makeUser();
    const foreign = await testBotTextTurn(stranger.id, botId, '/prices');
    expect(foreign.error).toMatch(/not found/i);
  });

  test('fallback reply catches unmatched free text; /help lists custom commands', async () => {
    const owner = await makeUser();
    const created = await createUserBot(owner.id, {
      name: 'Fallback Bot',
      commands: [{ command: '/hours', description: 'Opening hours', kind: 'static', response: '9-5' }],
      replies: [{ id: 'r9', name: 'Fallback', trigger: { type: 'fallback' }, messages: [{ text: 'Try /hours' }] }],
    });
    const record = await runtimeRecord(created.bot!.id);
    const sender = capturingSender();

    await handleBotMessage(record!, sender, { chatId: 't:1', text: 'blah blah', fromBot: false }, { store: realStore() });
    expect(sender.sends).toHaveLength(1);
    expect(sender.sends[0].text).toContain('Try /hours');

    sender.sends.length = 0;
    await handleBotMessage(record!, sender, { chatId: 't:1', text: '/help', fromBot: false }, { store: realStore() });
    expect(sender.sends[0].text).toContain('/hours — Opening hours');
  });

  test('deep-link start payload is acknowledged; photo caption reaches the AI as text', async () => {
    const owner = await makeUser();
    const created = await createUserBot(owner.id, {
      name: 'Media Bot',
      telegramToken: '1234567890:AAValidFormatTokenForTesting1234',
    });
    await db.bot.update({
      where: { id: created.bot!.id },
      data: { provider: 'custom', baseUrl: `${TELEGRAM_STUB_BASE}/v1`, apiKeyRef: SecretManager.encrypt('stub-key') },
    });
    const record = await runtimeRecord(created.bot!.id);
    

    const sender = capturingSender();
    await handleBotMessage(record!, sender, { chatId: 't:1', text: '/start ref_ABC123', fromBot: false }, { store: realStore() });
    expect(sender.sends[0].text).toContain('is online');

    const aiSender = capturingSender();
    await handleBotMessage(record!, aiSender, { chatId: 't:1', text: 'What is on this menu?', hasPhoto: true, fromBot: false }, { store: realStore() });
    expect(aiSender.sends).toHaveLength(1);
    // Memory stored the caption with the photo note.
    const conv = await db.conversation.findFirst({ where: { botId: created.bot!.id } });
    const lastUser = await db.message.findFirst({ where: { conversationId: conv!.id, role: 'user' }, orderBy: { timestamp: 'desc' } });
    expect(lastUser?.content).toContain('photo');
  });

  test('unknown callback data answers honestly and never crashes', async () => {
    const owner = await makeUser();
    const created = await createUserBot(owner.id, { name: 'Cb Bot', telegramToken: '1234567890:AAValidFormatTokenForTesting1234' });
    const record = await runtimeRecord(created.bot!.id);
    const sender = capturingSender();
    await handleBotCallback(record!, sender, { chatId: 't:1', callbackId: 'cb1', data: 'r:ghost', fromBot: false }, { store: realStore() });
    expect(sender.answers[0].text).toContain('no longer wired');
  });
});

// ---------------------------------------------------------------------------
// Referrals + entitlements
// ---------------------------------------------------------------------------

describe('referral system', () => {
  test('full flow: invite → pending at signup → qualified at verify → inviter entitled', async () => {
    const inviter = await makeUser();
    const { code } = await getOrCreateInvite(inviter.id);
    expect(code).toHaveLength(10);

    const invited = await makeUser();
    expect(await recordReferralSignup(invited.id, code)).toBe(true);
    expect(await hasEntitlement(inviter.id, 'premium')).toBe(false); // not yet qualified

    await qualifyReferralForUser(invited.id);
    expect(await hasEntitlement(inviter.id, 'premium')).toBe(true);

    const stats = await referralStats(inviter.id);
    expect(stats.invited).toBe(1);
    expect(stats.qualified).toBe(1);
    expect(stats.rewardDaysTotal).toBe(2);
  });

  test('abuse guards: self-referral, unknown codes, and duplicate claims are refused', async () => {
    const inviter = await makeUser();
    const { code } = await getOrCreateInvite(inviter.id);

    expect(await recordReferralSignup(inviter.id, code)).toBe(false); // self
    expect(await recordReferralSignup((await makeUser()).id, 'GARBAGE')).toBe(false); // unknown

    const invited = await makeUser();
    expect(await recordReferralSignup(invited.id, code)).toBe(true);
    expect(await recordReferralSignup(invited.id, code)).toBe(false); // duplicate invited user

    // A second account of the same invited person cannot double-claim —
    // rewards are per invited USER, and qualification happens server-side.
    await qualifyReferralForUser(invited.id);
    expect(await db.referralReward.count({ where: { invitedUserId: invited.id, status: 'qualified' } })).toBe(1);
  });

  test('entitlements extend rather than duplicate while active', async () => {
    const inviter = await makeUser();
    const { code } = await getOrCreateInvite(inviter.id);
    const a = await makeUser();
    const b = await makeUser();
    await recordReferralSignup(a.id, code);
    await recordReferralSignup(b.id, code);
    await qualifyReferralForUser(a.id);
    const first = await db.entitlement.findFirst({ where: { userId: inviter.id }, orderBy: { expiresAt: 'desc' } });
    await qualifyReferralForUser(b.id);
    const rows = await db.entitlement.findMany({ where: { userId: inviter.id, feature: 'premium' } });
    expect(rows).toHaveLength(1); // extended, not duplicated
    expect(rows[0].id).toBe(first!.id);
    expect(rows[0].expiresAt.getTime()).toBeGreaterThan(first!.expiresAt.getTime());
  });
});
