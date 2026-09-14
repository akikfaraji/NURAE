/**
 * NURAE — chat sessions: the multi-conversation service behind /chats.
 *
 * Model:
 *   ChatSession (kind "chat") → ChatEntry rows (user/assistant/system).
 *   Files attach to entries by reference (UserFile rows created by the
 *   upload API); file TEXT enters the model context in bounded slices
 *   (pickFileContext) — documents are never dumped wholesale.
 *
 * Chat → Agent routing (the front-layer behavior):
 *   The chat AI answers questions itself. When a request requires real work
 *   (build/modify a bot), it appends a machine directive as the last line:
 *     {"handoff":"bot-builder","task":"…"}
 *   NURAE detects it, spins up an agent session, seeds it with the task and
 *   the referenced files (BY REFERENCE — no re-upload), runs the agent's
 *   first turn, and returns the handoff so the UI can offer [Open in Agent].
 */

import { db } from '@/lib/db';
import { z } from 'zod';
import { rateLimit } from '../auth/rate-limit';
import { getOfficialBot } from '../auth/official-bot';
import { selectProvider } from '../ai/registry';
import type { ChatMessage } from '../ai/types';
import { pickFileContext, type FileRef } from '../files';
import { chargeFeature } from '../billing/wallet';
import { ensureAgentSession, latestActiveAgentSession, addFileRefs, runBotBuilderTurn, type AgentActivity } from '../agents/bot-builder';

const TURN_LIMIT = 20; // messages per minute per user
const TURN_WINDOW_MS = 60 * 1000;
const MAX_TEXT = 8000;
const HISTORY_ENTRIES = 24;

// ---------------------------------------------------------------------------
// Session CRUD
// ---------------------------------------------------------------------------

export interface SessionDTO {
  id: string;
  kind: string;
  agent: string | null;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
  preview: string | null;
}

function toSessionDTO(
  row: {
    id: string;
    kind: string;
    agent: string | null;
    title: string;
    status: string;
    createdAt: Date;
    updatedAt: Date;
    lastMessageAt: Date | null;
  },
  preview: string | null,
): SessionDTO {
  return {
    id: row.id,
    kind: row.kind,
    agent: row.agent,
    title: row.title,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastMessageAt: row.lastMessageAt ? row.lastMessageAt.toISOString() : null,
    preview,
  };
}

export async function listSessions(userId: string, kind: 'chat' | 'agent' | 'all' = 'all') {
  const rows = await db.chatSession.findMany({
    where: { userId, ...(kind === 'all' ? {} : { kind }), status: 'active' },
    orderBy: [{ lastMessageAt: 'desc' }, { updatedAt: 'desc' }],
    take: 100,
  });
  const previews = await latestEntries(rows.map((r) => r.id));
  return rows.map((r) => toSessionDTO(r, previews.get(r.id) ?? null));
}

async function latestEntries(sessionIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!sessionIds.length) return map;
  const rows = await db.chatEntry.findMany({
    where: { sessionId: { in: sessionIds }, role: { in: ['user', 'assistant'] } },
    orderBy: { createdAt: 'desc' },
    take: 400,
  });
  for (const row of rows) {
    if (!map.has(row.sessionId)) map.set(row.sessionId, row.content.slice(0, 80));
  }
  return map;
}

export async function createSession(
  userId: string,
  input: { kind?: 'chat' | 'agent'; agent?: 'bot-builder'; title?: string },
): Promise<SessionDTO> {
  const kind = input.kind === 'agent' ? 'agent' : 'chat';
  const row = await db.chatSession.create({
    data: {
      userId,
      kind,
      agent: kind === 'agent' ? input.agent ?? 'bot-builder' : null,
      title: (input.title || 'New chat').slice(0, 60),
    },
  });
  return toSessionDTO(row, null);
}

export interface EntryDTO {
  id: string;
  role: string;
  content: string;
  attachments: Array<{ fileId: string; name: string; kind: string }>;
  activity: AgentActivity[];
  needsConfirm: boolean;
  draftBotId: string | null;
  handoff: { agent: string; sessionId: string } | null;
  createdAt: string;
}

export async function getSessionWithEntries(userId: string, sessionId: string) {
  const session = await db.chatSession.findFirst({ where: { id: sessionId, userId } });
  if (!session) return null;
  const rows = await db.chatEntry.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'asc' },
    take: 300,
  });
  const entries: EntryDTO[] = rows.map((r) => {
    let meta: Record<string, unknown> = {};
    try {
      meta = r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : {};
    } catch {
      meta = {};
    }
    return {
      id: r.id,
      role: r.role,
      content: r.content,
      attachments: (meta.attachments as EntryDTO['attachments']) ?? [],
      activity: (meta.activity as EntryDTO['activity']) ?? [],
      needsConfirm: Boolean(meta.needsConfirm),
      draftBotId: (meta.draftBotId as string | null) ?? null,
      handoff: (meta.handoff as EntryDTO['handoff']) ?? null,
      createdAt: r.createdAt.toISOString(),
    };
  });
  return { session: toSessionDTO(session, null), entries };
}

export async function renameSession(userId: string, sessionId: string, title: string) {
  const row = await db.chatSession.findFirst({ where: { id: sessionId, userId } });
  if (!row) return null;
  const updated = await db.chatSession.update({
    where: { id: sessionId },
    data: { title: title.trim().slice(0, 60) || row.title },
  });
  return toSessionDTO(updated, null);
}

export async function setSessionStatus(userId: string, sessionId: string, status: 'active' | 'archived') {
  const row = await db.chatSession.findFirst({ where: { id: sessionId, userId } });
  if (!row) return null;
  const updated = await db.chatSession.update({ where: { id: sessionId }, data: { status } });
  return toSessionDTO(updated, null);
}

export async function deleteSession(userId: string, sessionId: string): Promise<boolean> {
  const row = await db.chatSession.findFirst({ where: { id: sessionId, userId }, select: { id: true } });
  if (!row) return false;
  await db.chatSession.delete({ where: { id: sessionId } });
  return true;
}

// ---------------------------------------------------------------------------
// The chat turn
// ---------------------------------------------------------------------------

const HANDOFF_RE = /\{\s*"handoff"\s*:\s*"bot-builder"\s*,\s*"task"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/i;

export interface ChatTurnResult {
  reply: string;
  handoff: { agent: string; sessionId: string; task: string } | null;
  error?: string;
}

export interface ChatTurnInput {
  userId: string;
  sessionId: string;
  text: string;
  attachmentIds?: string[];
}

/**
 * One /chats turn for a normal (kind="chat") session. Handles attachments,
 * file context, the AI call, handoff detection and persistence. Never throws.
 */
export async function chatTurn(input: ChatTurnInput): Promise<ChatTurnResult> {
  const text = input.text.trim().slice(0, MAX_TEXT);
  if (!text && !(input.attachmentIds ?? []).length) {
    return { reply: '', handoff: null, error: 'Type a message first.' };
  }

  const rl = rateLimit(`chat-turn:${input.userId}`, TURN_LIMIT, TURN_WINDOW_MS);
  if (!rl.allowed) {
    return { reply: '', handoff: null, error: `Too fast — try again in ${rl.retryAfter}s.` };
  }

  const session = await db.chatSession.findFirst({
    where: { id: input.sessionId, userId: input.userId, kind: 'chat' },
  });
  if (!session) return { reply: '', handoff: null, error: 'Chat not found' };

  const platformBot = await getOfficialBot();
  if (!platformBot) return { reply: '', handoff: null, error: 'The AI layer is unavailable right now.' };
  const selection = selectProvider(platformBot.provider, { apiKey: null, baseUrl: platformBot.baseUrl });
  let apiKey: string | null = null;
  if (platformBot.apiKeyRef) {
    try {
      const { SecretManager } = await import('../secrets');
      apiKey = SecretManager.decrypt(platformBot.apiKeyRef);
    } catch {
      apiKey = null;
    }
  }
  if (selection.info.requiresKey && !apiKey && !selection.apiKey) {
    return { reply: '', handoff: null, error: 'The AI layer has no key configured yet.' };
  }

  // Resolve attachments with ownership checks; keep them as references.
  const attachments: Array<{ fileId: string; name: string; kind: string }> = [];
  for (const fileId of (input.attachmentIds ?? []).slice(0, 5)) {
    const row = await db.userFile.findFirst({
      where: { id: fileId, userId: input.userId },
      select: { id: true, name: true, kind: true },
    });
    if (row) attachments.push({ fileId: row.id, name: row.name, kind: row.kind });
  }

  await db.chatEntry.create({
    data: {
      sessionId: session.id,
      role: 'user',
      content: text,
      meta: attachments.length ? JSON.stringify({ attachments }) : null,
    },
  });
  await db.chatSession.update({
    where: { id: session.id },
    data: {
      lastMessageAt: new Date(),
      title:
        session.title === 'New chat' && text
          ? text.slice(0, 60)
          : session.title,
    },
  });

  // Context: bounded file slices + recent history.
  const fileContext = attachments.length
    ? await pickFileContext(input.userId, attachments as FileRef[])
    : '';
  const historyRows = await db.chatEntry.findMany({
    where: { sessionId: session.id },
    orderBy: { createdAt: 'desc' },
    take: HISTORY_ENTRIES,
  });
  const history: ChatMessage[] = historyRows
    .reverse()
    .filter((e) => e.role === 'user' || e.role === 'assistant')
    .map((e) => ({ role: e.role === 'assistant' ? 'assistant' : 'user', content: e.content.slice(0, 4000) }));

  const systemPrompt: string = [
    platformBot.systemPrompt,
    '',
    '## Your role in NURAE',
    'You are the conversational front layer. Answer questions, explain concepts, help the user think.',
    'When a request needs REAL WORK done — e.g. "build me a Telegram bot", "use this document to make',
    'my bot", "modify my existing bot" — you do not do the work yourself. End your reply with exactly',
    'this line (and nothing after it):',
    '{"handoff":"bot-builder","task":"<one-sentence summary of what to build/modify>"}',
    'Everything else: just answer normally (no directive). Respond in the user\u2019s language.',
    fileContext ? `\n## Attached files (user uploaded; cite them when relevant)\n${fileContext}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }, ...history];

  // Pay-as-you-use: one assistant turn (trial/premium/free-quota absorb it).
  const charge = await chargeFeature(input.userId, 'ai_assistant').catch(() => null);
  if (charge?.outcome === 'skipped') {
    return {
      reply: '',
      handoff: null,
      error: 'Out of credits — a turn costs $0.002. Top up in Billing (Stars or crypto) to keep chatting.',
    };
  }

  let reply: string;
  try {
    reply = await selection.provider.generate(messages, {
      model: platformBot.model,
      temperature: platformBot.temperature,
      maxTokens: platformBot.maxTokens,
      apiKey: apiKey ?? selection.apiKey,
      baseUrl: selection.baseUrl,
    });
  } catch (err) {
    const code = err instanceof z.ZodError ? 'invalid' : (err as Error).message;
    return { reply: '', handoff: null, error: `The assistant could not answer right now (${code.slice(0, 120)}).` };
  }

  // Handoff detection — the directive must be the machine tail of the reply.
  const tail = reply.slice(-400);
  const m = HANDOFF_RE.exec(tail);
  if (m) {
    let task = 'Build a Telegram bot';
    try {
      task = JSON.parse(`{"task":"${m[1]}"}`).task as string;
    } catch {
      task = m[1];
    }
    const cleanReply = reply.slice(0, reply.length - m[0].length).trim();

    // ONE ongoing build workspace: a new handoff CONTINUES the user's latest
    // agent session (draft-bot state, file refs and memory stay in one
    // place) instead of forking a parallel session — and possibly a parallel
    // draft bot — on every build request. Older than 7 days (or none) → a
    // fresh session is started.
    const fileRefs = attachments.map((a) => ({ fileId: a.fileId, name: a.name }));
    const existingSessionId = await latestActiveAgentSession(input.userId);
    let agentSessionId: string;
    if (existingSessionId) {
      agentSessionId = existingSessionId;
      if (fileRefs.length) await addFileRefs(agentSessionId, fileRefs);
    } else {
      agentSessionId = await ensureAgentSession(input.userId, {
        agent: 'bot-builder',
        title: task.slice(0, 60),
        fileRefs,
      });
    }
    const agentResult = await runBotBuilderTurn({
      userId: input.userId,
      sessionId: agentSessionId,
      userText: text || task,
    });

    await db.chatEntry.create({
      data: {
        sessionId: session.id,
        role: 'assistant',
        content: cleanReply || 'I can have the Bot Builder agent take care of this.',
        meta: JSON.stringify({
          handoff: { agent: 'bot-builder', sessionId: agentSessionId, task },
          attachments,
        }),
      },
    });
    await db.chatSession.update({ where: { id: session.id }, data: { lastMessageAt: new Date() } });

    return {
      reply: cleanReply || 'I can have the Bot Builder agent take care of this.',
      handoff: { agent: 'bot-builder', sessionId: agentSessionId, task },
    };
  }

  // Normal reply — persist and return.
  await db.chatEntry.create({
    data: {
      sessionId: session.id,
      role: 'assistant',
      content: reply,
      meta: attachments.length ? JSON.stringify({ attachments }) : null,
    },
  });
  await db.chatSession.update({ where: { id: session.id }, data: { lastMessageAt: new Date() } });
  return { reply, handoff: null };
}
