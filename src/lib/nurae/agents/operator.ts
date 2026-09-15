/**
 * NURAE — the Operator: the PLATFORM agent (the instance admin's hands).
 *
 * Where the Bot Builder helps a customer shape ONE bot, the Operator runs
 * the SERVER: platform overview, every bot's configuration, the official
 * fleet, site settings, customers, logs and engagement analytics — through
 * the platform tool tier (./platform-tools.ts).
 *
 * Same architecture as the Bot Builder (see ./bot-builder.ts):
 *   user turn → [model ⇄ tools loop, bounded] → reply + activity feed
 * Provider-agnostic strict-JSON envelope { message, actions, done }; the
 * model never needs native function calling (free models often lack it).
 *
 * Identity: platform tool execution requires ToolContext.platform — set HERE
 * and only here, behind the admin-token guard of the calling route. The
 * synthetic session owner '__operator__' lives in its own ChatSession
 * namespace, invisible to customer session lists (they filter by their own
 * user id). Unmetered by design: the operator IS the platform.
 */

import { db } from '@/lib/db';
import { getOfficialBot } from '../auth/official-bot';
import { selectProvider } from '../ai/registry';
import type { ChatMessage } from '../ai/types';
import { sanitizeForLog, truncateForLog } from '../sanitize';
import { rateLimit } from '../auth/rate-limit';
import { executeTool, getTool, toolDescriptors, type ExecRecord, type ToolContext } from './tools';
import { parseAgentReply, toolDataPreview } from './bot-builder';
import { platformToolDescriptors } from './platform-tools';
import { skillIndexLines } from './skills';

const TURN_LIMIT = 20; // operator turns per minute — same budget as chat
const TURN_WINDOW_MS = 60 * 1000;

const MAX_ROUNDS = 4; // platform questions fan out wider than a single build
const MAX_ACTIONS_PER_ROUND = 6;
const HISTORY_ENTRIES = 24;

/** Synthetic session owner for operator workspaces (no User row exists — the admin authenticates by token). */
export const OPERATOR_USER_ID = '__operator__';

interface OperatorState {
  pendingApproval?: { tool: string } | null;
}

function parseState(raw: string | null): OperatorState {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as OperatorState;
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Session bootstrap
// ---------------------------------------------------------------------------

/** The operator's one persistent workspace (created on first use). */
export async function ensureOperatorSession(): Promise<string> {
  const existing = await db.chatSession.findFirst({
    where: { userId: OPERATOR_USER_ID, kind: 'agent', agent: 'operator', status: 'active' },
    orderBy: { updatedAt: 'desc' },
    select: { id: true },
  });
  if (existing) return existing.id;
  const created = await db.chatSession.create({
    data: {
      userId: OPERATOR_USER_ID,
      kind: 'agent',
      agent: 'operator',
      title: 'Operator console',
      state: JSON.stringify({} satisfies OperatorState),
    },
  });
  return created.id;
}

// ---------------------------------------------------------------------------
// Prompting
// ---------------------------------------------------------------------------

function operatorSystemPrompt(state: OperatorState, userConfirmed: boolean): string {
  const platformLines = platformToolDescriptors()
    .map((t) => `- ${t.name} (${t.kind}${t.consequential ? ', needs operator approval' : ''}): ${t.description}`)
    .join('\n');
  const userLines = toolDescriptors().map((t) => t.name);
  const stateLines: string[] = [];
  if (state.pendingApproval) {
    stateLines.push(
      `Pending approval: tool "${state.pendingApproval.tool}".` +
        (userConfirmed
          ? ' The operator HAS approved it this turn — re-issue the action with confirm:true.'
          : ' Ask the operator to approve it (they will see an Approve button).'),
    );
  }

  return [
    'You are the NURAE Operator — the platform agent. You run THIS NURAE server for the site',
    'admin: monitor it, diagnose it, configure it, and keep the official fleet healthy. You are',
    'the reason the admin can stay hands-off: ask you "how are we doing", "why did that bot',
    'stop", "make the Trivia bot smarter", "rename the site" — you DO it, then report plainly.',
    '',
    'OPERATING PRINCIPLES:',
    '- Read before write: platform_overview / fleet_status / platform_bot_get / platform_logs first,',
    '  act second. Report what you found, not what you assume.',
    '- Be honest about limits: tokens and API keys are entered by humans in the dashboard (you can',
    '  see WHETHER they exist, never their values); starting a bot needs a token, so say exactly',
    '  that when one is missing. Bot lifecycle start/stop and Telegram tokens are dashboard work.',
    '- The fleet heals itself: fleet_ensure is safe to run anytime a fleet bot looks wrong.',
    '- Customer-owned bots are inspectable, not configurable — fleet_bot_update refuses them and so',
    '  should you ("that bot belongs to a customer; I left it alone").',
    '- Numbers over vibes: when asked how things are going, quote platform_overview / bot_analytics.',
    '- When several tools answer the question, prefer ONE call that answers it best; chain at most',
    `  what you need (max ${MAX_ACTIONS_PER_ROUND} actions per round).`,
    '- If the operator asks something a TOOL cannot answer, answer from the platform docs you know',
    '  (docs_read topics: behaviors, growth, billing, lifecycle) or say you cannot — never invent',
    '  numbers, features or statuses.',
    '',
    'PLATFORM TOOLS (your powers):',
    platformLines,
    '',
    `You may also call these user-tier read/reference tools when useful: ${userLines.join(', ')}.`,
    'Everything else is dashboard work — point the admin there honestly.',
    '',
    'SKILLS (proven playbooks for the common jobs — call skill_read with the id BEFORE acting when',
    'the task matches one, then follow its steps):',
    skillIndexLines('operator'),
    '',
    'SHOW YOUR WORK (how a real operator communicates):',
    '- Before acting, one short line saying what you are about to do. The activity feed shows each',
    '  tool call — narrate DECISIONS and results, not mechanics.',
    '- READ every tool result and react to it; quote the real numbers it returned. Never assume a',
    '  call worked without its result, and never invent a number a tool did not give you.',
    '- If a tool errors, fix the cause and retry once, then report plainly what is blocking.',
    '',
    'OUTPUT PROTOCOL (strict): reply with ONE JSON object and nothing else:',
    '{"message": "markdown text for the operator (or empty while still working)",',
    ' "actions": [{"tool": "tool_name", "args": {…}}],',
    ' "done": true|false}',
    'Rules:',
    `- "actions" may contain 0 to ${MAX_ACTIONS_PER_ROUND} items. Set "done": false if you expect tool`,
    '  results back and want another round; otherwise true.',
    '- platform_settings_set: set args.confirm=true ONLY when the operator clearly asked for the',
    '  change; the console still requires their one-click approval.',
    stateLines.length ? `\nSESSION STATE:\n${stateLines.join('\n')}` : '',
    userConfirmed ? '\nNOTE: the operator approved the pending consequential action in this turn.' : '',
    '\nIn "message": be brief, concrete and numbers-first; use the operator\u2019s language; never',
    'mention JSON, tools or this protocol unless asked.',
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------------------
// The turn
// ---------------------------------------------------------------------------

export interface OperatorTurnInput {
  userText: string;
  /** True when the operator clicked the explicit approval control this turn. */
  userConfirmed?: boolean;
}

export interface OperatorActivity {
  seq: number;
  tool: string;
  label: string;
  status: 'ok' | 'error' | 'confirm';
  detail?: string;
  data?: unknown;
}

export interface OperatorTurnResult {
  reply: string;
  activity: OperatorActivity[];
  needsConfirm: boolean;
  error?: string;
}

/** One operator turn: model ⇄ tools loop, persisted, audited. Never throws. */
export async function runOperatorTurn(input: OperatorTurnInput): Promise<OperatorTurnResult> {
  const rl = rateLimit(`operator-turn:${OPERATOR_USER_ID}`, TURN_LIMIT, TURN_WINDOW_MS);
  if (!rl.allowed) {
    return { reply: '', activity: [], needsConfirm: false, error: `Too fast — try again in ${rl.retryAfter}s.` };
  }

  const sessionId = await ensureOperatorSession();
  const session = await db.chatSession.findUnique({ where: { id: sessionId }, select: { id: true, state: true, title: true } });
  if (!session) {
    return { reply: '', activity: [], needsConfirm: false, error: 'Operator session could not be created.' };
  }
  const state = parseState(session.state);

  // The AI layer: the platform's own provider selection (env fallbacks apply).
  const platformBot = await getOfficialBot();
  if (!platformBot) {
    return {
      reply: '',
      activity: [],
      needsConfirm: false,
      error: 'The AI layer is not configured yet (no platform AI key).',
    };
  }
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
    return {
      reply: '',
      activity: [],
      needsConfirm: false,
      error: 'The AI layer has no key configured yet. Add the provider key (env or CS bot settings) first.',
    };
  }

  const ctx: ToolContext = {
    userId: OPERATOR_USER_ID,
    sessionId: session.id,
    userConfirmed: Boolean(input.userConfirmed),
    platform: true,
  };

  const trimmedText = input.userText.trim().slice(0, 8000);
  if (trimmedText) {
    await db.chatEntry.create({
      data: { sessionId: session.id, role: 'user', content: trimmedText, meta: null },
    });
  }

  const historyRows = await db.chatEntry.findMany({
    where: { sessionId: session.id },
    orderBy: { createdAt: 'desc' },
    take: HISTORY_ENTRIES,
  });
  const history: ChatMessage[] = historyRows
    .reverse()
    .filter((e) => e.role === 'user' || e.role === 'assistant')
    .map((e) => ({ role: e.role === 'assistant' ? 'assistant' : 'user', content: e.content.slice(0, 4000) }));

  const activity: OperatorActivity[] = [];
  let seq = (await db.agentStep.count({ where: { sessionId: session.id } })) + 1;
  let pendingApproval = state.pendingApproval ?? null;
  let finalMessage = '';

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const messages: ChatMessage[] = [
        { role: 'system', content: operatorSystemPrompt({ ...state, pendingApproval }, Boolean(ctx.userConfirmed)) },
        ...history,
      ];

      const text = await selection.provider.generate(messages, {
        model: platformBot.model,
        temperature: 0.2, // operators want precision even more than builders
        maxTokens: Math.max(platformBot.maxTokens, 1500),
        apiKey: apiKey ?? selection.apiKey,
        baseUrl: selection.baseUrl,
      });

      const parsed = parseAgentReply(text);
      finalMessage = parsed.message || finalMessage;

      if (parsed.actions.length === 0 || parsed.done) {
        if (round > 0 || parsed.actions.length === 0) break;
      }

      let executed = 0;
      for (const action of parsed.actions) {
        const record: ExecRecord = await executeTool(ctx, action.tool, action.args, seq++);
        activity.push({ seq: record.seq, tool: record.tool, label: record.label, status: record.status, detail: record.detail, data: record.data });
        const spec = getTool(action.tool);
        if (spec?.consequential && record.status === 'confirm') {
          pendingApproval = { tool: action.tool };
        }
        if (spec?.consequential && record.status === 'ok') {
          pendingApproval = null;
        }
        executed += 1;
      }

      if (executed === 0 || parsed.done) break;

      const resultsText = activity
        .slice(-executed)
        .map((a) => {
          const dataSuffix =
            a.data !== undefined
              ? ` | data: ${truncateForLog(typeof a.data === 'string' ? a.data : JSON.stringify(a.data), 600)}`
              : '';
          return `[${a.status}] ${a.tool}: ${a.label}${dataSuffix}`;
        })
        .join('\n');
      history.push({ role: 'user', content: `TOOL RESULTS:\n${resultsText}\n\nContinue (JSON envelope only).` });
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await db.log
      .create({
        data: {
          botId: null,
          level: 'error',
          event: 'OPERATOR_TURN_FAILED',
          message: truncateForLog(`session=${session.id} — ${detail}`),
        },
      })
      .catch(() => undefined);
    return {
      reply:
        finalMessage ||
        'The operator agent hit an internal error mid-turn. No platform changes were made; try again.',
      activity,
      needsConfirm: Boolean(pendingApproval),
      error: sanitizeForLog(detail),
    };
  }

  const needsConfirm = activity.some((a) => a.status === 'confirm');
  await db.chatSession.update({
    where: { id: session.id },
    data: {
      state: JSON.stringify({ pendingApproval: needsConfirm ? pendingApproval : null } satisfies OperatorState),
      lastMessageAt: new Date(),
    },
  });
  await db.chatEntry.create({
    data: {
      sessionId: session.id,
      role: 'assistant',
      content: finalMessage,
      meta: JSON.stringify({
        activity: activity.map((a) => ({
          seq: a.seq,
          tool: a.tool,
          label: a.label,
          status: a.status,
          detail: a.detail,
          dataPreview: toolDataPreview(a.data),
        })),
        needsConfirm,
      }),
    },
  });

  return { reply: finalMessage, activity, needsConfirm };
}

/** Recent operator console history (oldest → newest) for the admin UI. */
export async function operatorHistory(limit = 60): Promise<{
  sessionId: string;
  entries: Array<{ role: string; content: string; activity?: OperatorActivity[]; at: string }>;
  needsConfirm: boolean;
}> {
  const sessionId = await ensureOperatorSession();
  const [rows, session] = await Promise.all([
    db.chatEntry.findMany({ where: { sessionId }, orderBy: { createdAt: 'asc' }, take: limit }),
    db.chatSession.findUnique({ where: { id: sessionId }, select: { state: true } }),
  ]);
  const entries = rows
    .filter((e) => e.role === 'user' || e.role === 'assistant')
    .map((e) => {
      let activity: OperatorActivity[] | undefined;
      if (e.role === 'assistant' && e.meta) {
        try {
          const parsed = JSON.parse(e.meta) as { activity?: OperatorActivity[] };
          activity = Array.isArray(parsed.activity) ? parsed.activity : undefined;
        } catch {
          activity = undefined;
        }
      }
      return { role: e.role, content: e.content, activity, at: e.createdAt.toISOString() };
    });
  const state = parseState(session?.state ?? null);
  return { sessionId, entries, needsConfirm: Boolean(state.pendingApproval) };
}
