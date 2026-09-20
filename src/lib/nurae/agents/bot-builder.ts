/**
 * NURAE — agent runtime: the Bot Builder (first real agent; more later).
 *
 * Architecture:
 *   user turn → [model ⇄ tools loop (bounded)] → reply + activity feed
 *
 * The loop is provider-agnostic: it does NOT rely on native function calling
 * (free models often lack it). Instead the model is asked for a strict JSON
 * envelope { message, actions, done } and NURAE parses it leniently. Actions
 * are validated + executed through the tool registry (see ./tools.ts) —
 * identity is always the authenticated user, never the model.
 *
 * Persistence: entries in ChatEntry, tool invocations in AgentStep, task
 * state (draft bot id etc.) in ChatSession.state. Agent conversations
 * survive reloads and keep their context.
 */

import { db } from '@/lib/db';
import { getOfficialBot } from '../auth/official-bot';
import { selectProvider } from '../ai/registry';
import type { ChatMessage } from '../ai/types';
import { sanitizeForLog, truncateForLog } from '../sanitize';
import { rateLimit } from '../auth/rate-limit';
import { chargeFeature } from '../billing/wallet';
import { formatUsd } from '../billing/catalog';
import { executeTool, toolDescriptors, type ExecRecord, type ToolContext } from './tools';
import { extractMarkupCalls } from './tool-markup';
import { skillIndexLines } from './skills';
import type { GrowthLinks } from '../bots/templates';

const TURN_LIMIT = 20; // agent turns per minute per user — same budget as chat
const TURN_WINDOW_MS = 60 * 1000;

const MAX_ROUNDS = 6; // model rounds per user turn — a real build is create → configure → verify → report
const MAX_ACTIONS_PER_ROUND = 6;
const HISTORY_ENTRIES = 20;
/** Floor for per-round output tokens. Behavior-JSON envelopes are large; the
 *  old 1500 floor truncated them mid-generation, which ended turns mid-work
 *  (BR-034). The platform bot's own maxTokens stays respected above this. */
const AI_ROUND_TOKEN_FLOOR = 3000;

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

export interface AgentState {
  draftBotId?: string | null;
  pendingApproval?: { tool: string; botId: string } | null;
  lastSummary?: string | null;
  /** Files attached in the ORIGINATING chat (handoff) or this agent session. */
  fileRefs?: Array<{ fileId: string; name: string }>;
}

export function parseAgentState(raw: string | null): AgentState {
  if (!raw) return {};
  try {
    const s = JSON.parse(raw) as AgentState;
    return typeof s === 'object' && s !== null ? s : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Prompting
// ---------------------------------------------------------------------------

function builderSystemPrompt(state: AgentState, userApproved: boolean): string {
  const descriptors = toolDescriptors();
  const toolLines = descriptors
    .map(
      (t) =>
        `- ${t.name} (${t.kind}${t.consequential ? ', needs user approval' : ''}): ${t.description}`,
    )
    .join('\n');

  const stateLines: string[] = [];
  if (state.draftBotId) stateLines.push(`Current draft bot id: ${state.draftBotId}`);
  if (state.fileRefs?.length) {
    stateLines.push(
      `Files the user attached for this task (read with files_read): ${state.fileRefs
        .map((f) => `${f.name} (fileId: ${f.fileId})`)
        .join(', ')}`,
    );
  }
  if (state.pendingApproval) {
    stateLines.push(
      `Pending approval: tool "${state.pendingApproval.tool}" on bot ${state.pendingApproval.botId}.` +
        (userApproved
          ? ' The user HAS approved it this turn \u2014 you may re-issue the action with confirm:true.'
          : ' Ask the user to approve it (they will see an Approve button).'),
    );
  }

  return [
    'You are the NURAE Bot Builder. The user describes what their bot should DO \u2014 you make it happen.',
    'The user never needs to know about commands, inline keyboards, callbacks, or workflows. Those are',
    'YOUR implementation details: you speak in outcomes ("visitors see three buttons: Menu, Order, Contact"),',
    'and NURAE compiles the technical layer automatically. You are a knowledgeable product person, not a',
    'configuration panel.',
    '',
    'WHAT NURAE BOTS CAN DO (use these powers when the intent needs them \u2014 never fake one NURAE lacks):',
    '- Screens & flows: message steps with buttons; a button shows a message, opens a link, opens a Mini App',
    '  (webapp), copies text (copy), starts a flow (another behavior \u2014 create it in the SAME call), or asks the AI.',
    '- Every trigger: someone starts the bot; types a command; mentions a word ("says"); presses a button;',
    '  arrives from a deep link (payload \u2014 "the flyer link", referral codes); joins the group (member_joined);',
    '  anything else (AI or polite fallback).',
    '- Rich steps: send media (photo/video/audio/voice/animation/document/sticker by HTTPS URL); run a poll or',
    '  quiz; charge Telegram Stars for a digital product (payment \u2014 /terms /paysupport /support are added',
    '  automatically); ask a question and REMEMBER the answer (collect); set a reminder (schedule \u2014 the bot',
    '  parses "tomorrow at 9am" with its own AI).',
    '- Memory: collected answers are stored per user and rendered via {{placeholders}} ({{name}} works too).',
    '  "Order flow collects the name and address" is real: collect steps + {{name}} in the confirmation.',
    '- Promotion primitives: remember (silently set or ADD to an attribute — invite counters, giveaway entries,',
    '  quiz scores: {"type":"remember","remember":{"attribute":"score","value":"1","mode":"add"}}); draw (a',
    '  random winner among users holding an attribute — announce with {{winner_name}} {{winner_chat}} {{count}});',
    '  top (post the leaderboard: {"type":"top","top":{"attribute":"score","title":"Top players","limit":10}}).',
    '- Placeholders go further: {{chat_id}}, {{bot_username}} (bare, link-ready) and fallbacks — {{score|0}}',
    '  renders 0 until it exists. Copy buttons and link URLs template too, so a personal invite link is',
    '  https://t.me/{{bot_username}}?start=ref_{{chat_id}} — arrivals with that payload AUTO-CREDIT ref_<chatId>',
    '  (the invite loop is built in: joiner stores invited_by, inviter\'s invites counter increments).',
    '- Forms: message steps can use a reply keyboard (keyboard:"reply" \u2014 taps send the label as text),',
    '  forceReply, or edit the pressed message in place (edit:true \u2014 settings/pagination/carts).',
    '- Groups: command behaviors always work; free text only when someone @mentions the bot; member_joined',
    '  welcomes new members. Group moderation/admin powers are NOT available \u2014 say so honestly.',
    '- Reach & rhythm: bot_broadcast (needs approval) newsletters to everyone who ever wrote; ',
    '  bot_schedule_message for drip content; bot_set_profile writes the public description Telegram shows',
    '  BEFORE anyone presses Start \u2014 always set it, one strong sentence.',
    '- Personalization: bot_list_users shows who is here and what they told the bot.',
    '',
    'BLUEPRINT PATTERNS (recognize the intent, adapt \u2014 do not build a generic Q&A shell):',
    '- FAQ/support assistant: start welcome + buttons (FAQ, Contact, Hours) + says triggers for top questions',
    '  + anything_else AI fed by bot_add_knowledge. Ask: top 5 questions? what must NEVER be AI-answered?',
    '- Shop / digital product: /menu catalog buttons \u2192 product page \u2192 payment step (Stars) \u2192 successText',
    '  delivers the goods; media step for the cover image. Ask: products, prices, delivery.',
    '- Booking / intake form: collect steps chained (service \u2192 name \u2192 preferred time) + a summary message',
    '  with {{placeholders}}. Ask: services, hours, timezone.',
    '- Reminder/habit bot: schedule step in a flow ("tell me what and when") + a daily broadcast alternative.',
    '- Restaurant: /menu with photos, /order collect flow, /reserve; anything_else AI for the rest.',
    '- Newsletter: /subscribe stores nothing special (the chat IS the subscriber list) \u2014 owner broadcasts.',
    '- Event bot: /schedule /speakers /faq commands + payload trigger from the poster link ("event flyer").',
    '- Group welcome bot: member_joined behavior with rules + buttons; mention-gated helper.',
    '- Quiz/game: button-driven questions with remember(mode:"add") scoring + a top leaderboard — instant',
    '  feedback beats raw polls when points matter; polls stay for anonymous vibes. Giveaway: an enter button',
    '  that remembers "entered" + a /draw command. Referral program: personal deep links + invites counter +',
    '  top referrers.',
    '- If a capability is missing (inline mode, moderation, games, channels), say it in plain words and offer',
    '  the nearest buildable alternative. Never simulate it.',
    '',
    'HOW TO BUILD (intent-first):',
    '- Turn every "when X happens, do Y" the user mentions (explicitly or implicitly) into ONE behavior.',
    '- Buttons inside a message need an action. If a button starts a flow, CREATE the target behavior in the',
    '  SAME bot_set_behaviors call \u2014 never leave a button pointing at nothing. Back/cancel affordances in',
    '  nested flows.',
    '- Proactively build the pieces the user implies. "Add a Contact button" means you also decide what',
    '  pressing it should sensibly do; say what you chose in one short line.',
    '- If the request is ambiguous, ask ONE short, concrete question ("Should ordering send you the',
    '  order as a message?"). Never interrogate, never expose configuration screens. Clarify: private chat',
    '  or group? the three golden flows? fallback = AI or static "contact us"? do they have texts to upload?',
    '- Documents attached? Read them (files_list/files_read), distill what matters, bot_add_knowledge.',
    '- Copy style: write like a competent human \u2014 short lines, active verbs, no emoji walls, no brochures.',
    '  The /start screen is one line of value + 2\u20133 buttons.',
    '',
    'TOOLS (the only capabilities you have \u2014 never invent others):',
    toolLines,
    '',
    'SKILLS (proven playbooks for the common jobs \u2014 call skill_read with the id BEFORE acting when',
    'the task matches one, then follow its steps; adapt to the request, don\u2019t recite):',
    skillIndexLines('builder'),
    '',
    'SHOW YOUR WORK (how a real agent communicates):',
    '- Before acting, one short line in "message" saying what you are about to do ("Setting up the',
    '  order flow and wiring your alerts now"). The activity feed already shows each tool call \u2014',
    '  narrate DECISIONS and results, not mechanics.',
    '- After tool results come back, READ them and react: fix what failed, verify what succeeded,',
    '  never assume a call worked without its result. Quote real numbers the tools returned.',
    '- If a tool returns an error, fix the cause (wrong id, missing field) and retry once; then',
    '  explain plainly what is blocking and what you need from the user.',
    '',
    'OUTPUT PROTOCOL (strict): reply with ONE JSON object and nothing else:',
    '{"message": "markdown text for the user (or empty while still working)",',
    ' "actions": [{"tool": "tool_name", "args": {…}}],',
    ' "done": true|false}',
    'Rules:',
    '- Tool calls happen ONLY through "actions". NEVER emit markup such as <tool_call>, <invoke>,',
    '  mcp:tool, function-call brackets or name=value call syntax — that is not this protocol.',
    '- "actions" may contain 0 to ' + MAX_ACTIONS_PER_ROUND + ' items. BATCH WORK: put every independent call of the',
    '  current step into ONE actions array — fewer rounds, faster builds. Use tools to DO things, not to narrate.',
    '- "done" is a hint, not a gate: NURAE always executes your actions and always shows you each tool\u2019s',
    '  result before the turn ends. Set "done": true once the task is complete and nothing is left to run.',
    '- Read tools first when you need information (files_list, files_read, bots_list, bot_get, bot_list_users).',
    '- Aim to finish a build in a few focused rounds: create → configure → verify → report. When the tool',
    '  results show the task is complete, reply with your final summary and no actions.',
    '- Build in this order when creating: bot_create_draft (with behaviors) \u2192 bot_set_behaviors for later',
    '  changes \u2192 bot_add_knowledge (if documents) \u2192 bot_set_profile \u2192 offer to publish. bot_set_commands /',
    '  bot_set_replies are ADVANCED escape hatches \u2014 prefer behaviors.',
    '- bot_publish / bot_unpublish / bot_broadcast: set args.confirm=true ONLY when the user asked for it;',
    '  NURAE still requires the user\u2019s one-click approval. If approval is missing, re-ask politely.',
    '- Behavior examples:',
    '  {"id":"welcome","title":"Welcome","when":{"type":"start"},"steps":[{"type":"message",',
    '   "text":"Welcome! What would you like to do?","buttons":[{"label":"Menu","action":{"kind":"flow","behaviorId":"menu"}},',
    '   {"label":"Contact","action":{"kind":"flow","behaviorId":"contact"}}]}]}',
    '  {"id":"order","title":"Order","when":{"type":"command","command":"/order"},"steps":[' +
      '{"type":"collect","collect":{"attribute":"dish","prompt":"What would you like to order?"}},' +
      '{"type":"collect","collect":{"attribute":"address","prompt":"Delivery address?"}},' +
      '{"type":"message","text":"Thanks {{name}}! Order: {{dish}} to {{address}}. We\\u2019ll confirm shortly."}]}',
    '  {"id":"deal","title":"Deal of the day","when":{"type":"button"},"steps":[{"type":"media","media":{"kind":"photo","source":"https://…/deal.jpg","caption":"Today only: **{{deal}}**"}}, {"type":"payment","payment":{"title":"Deal","description":"Deal of the day","priceStars":25,"successText":"Paid! Here is your access: …"}}]}',
    '  {"id":"remind","title":"Reminder","when":{"type":"command","command":"/remind"},"steps":[{"type":"schedule","schedule":{"prompt":"What should I remind you, and when? e.g. \\u201cwater the plants tomorrow at 9am\\u201d"}}]}',
    '  {"id":"welcome-group","title":"Group welcome","when":{"type":"member_joined"},"steps":[{"type":"message","text":"Welcome {{name}}! Read the rules and say hi."}]}',
    '  Behavior ids: short slugs (letters, digits, "-", "_").',
    stateLines.length ? `\nSESSION STATE:\n${stateLines.join('\n')}` : '',
    userApproved ? '\nNOTE: the user approved the pending consequential action in this turn.' : '',
    '\nIn "message" (what the user reads): be warm, concrete and brief; use the user\u2019s language;',
    'never mention callbacks, keyboards, parse modes or internal tool names unless the user asks',
    'technical questions.',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Lenient JSON envelope extraction — models add prose despite instructions.
 *
 * Hardening (V00.09.000): users must never see raw model JSON. The parser
 *   1. strips markdown code fences the model wrapped the envelope in,
 *   2. parses the widest {...} window as the envelope,
 *   3. on a broken envelope, salvages the "message" string field directly,
 *   4. otherwise shows only the prose OUTSIDE the braces (never the raw blob),
 *   5. and as a last resort replaces the malformed reply with a clean notice.
 */
const MALFORMED_NOTICE =
  'My reply came back malformed, so I discarded it instead of showing you raw data. Please send that again.';

export function parseAgentReply(text: string): {
  message: string;
  actions: Array<{ tool: string; args: Record<string, unknown> }>;
  done: boolean;
  jsonOk: boolean;
} {
  // 0. Tool-call markup dialects first (BR-030): tool_call tags,
  //  heredoc markers, invoke/mcp wrappers. They become real actions and are
  //  stripped from the text so no dialect residue can ever reach the bubble.
  const markup = extractMarkupCalls(text);
  const base = parseEnvelopeReply(markup.cleaned);
  const actions = [...base.actions, ...markup.calls].slice(0, MAX_ACTIONS_PER_ROUND);
  // Markup-only turns expect tool results back — keep the loop alive so the
  // model can react to them (bounded by MAX_ROUNDS).
  const done = !base.jsonOk && actions.length > 0 ? false : base.done;
  return { message: base.message, actions, done, jsonOk: base.jsonOk };
}

function parseEnvelopeReply(text: string): {
  message: string;
  actions: Array<{ tool: string; args: Record<string, unknown> }>;
  done: boolean;
  jsonOk: boolean;
} {
  // 1. Code fences off — ```json … ``` around the envelope is common.
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end <= start) {
    // Closing brace BEFORE the opening one — structural garbage.
    return { message: MALFORMED_NOTICE, actions: [], done: true, jsonOk: false };
  }
  if (start !== -1 && end > start) {
    const window = cleaned.slice(start, end + 1);
    try {
      const parsed = JSON.parse(window) as Record<string, unknown>;
      const actions = Array.isArray(parsed.actions) ? parsed.actions : [];
      return {
        message: typeof parsed.message === 'string' ? parsed.message : '',
        actions: actions
          .filter(
            (a): a is { tool: string; args: Record<string, unknown> } =>
              typeof (a as Record<string, unknown>)?.tool === 'string',
          )
          .slice(0, MAX_ACTIONS_PER_ROUND)
          .map((a) => ({ tool: a.tool, args: (a.args ?? {}) as Record<string, unknown> })),
        done: parsed.done !== false,
        jsonOk: true,
      };
    } catch {
      // 2. Broken envelope — salvage the human message if one exists.
      const salvaged = salvageMessageField(window);
      if (salvaged) return { message: salvaged, actions: [], done: true, jsonOk: false };
      // 3. Show only the prose outside the braces, never the raw blob.
      const outside = (cleaned.slice(0, start) + ' ' + cleaned.slice(end + 1)).trim();
      if (outside) return { message: outside, actions: [], done: true, jsonOk: false };
      // 4. Nothing but a broken envelope — clean notice, not raw JSON.
      return { message: MALFORMED_NOTICE, actions: [], done: true, jsonOk: false };
    }
  }
  if (start !== -1 && end === -1) {
    // Unclosed envelope (truncated generation). Salvage or notice — never raw.
    const salvaged = salvageMessageField(cleaned.slice(start));
    if (salvaged) return { message: salvaged, actions: [], done: true, jsonOk: false };
    return { message: MALFORMED_NOTICE, actions: [], done: true, jsonOk: false };
  }
  return { message: cleaned, actions: [], done: true, jsonOk: false };
}

/** Best-effort extraction of a "message": "…" string from broken JSON. */
function salvageMessageField(blob: string): string | null {
  const closed = blob.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (closed) {
    try {
      const unescaped = JSON.parse(`"${closed[1]}"`) as string;
      if (unescaped.trim()) return unescaped;
    } catch {
      /* fall through to the unterminated salvage */
    }
  }
  // Truncated generation: the message value never got its closing quote.
  const open = blob.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)$/);
  if (open && open[1].trim()) return open[1];
  return null;
}

/** Compact preview of a tool result for persistence + UI inspection. */
export function toolDataPreview(data: unknown, max = 700): string | undefined {
  if (data === undefined || data === null) return undefined;
  try {
    const raw = typeof data === 'string' ? data : JSON.stringify(data);
    if (!raw) return undefined;
    return raw.length > max ? raw.slice(0, max) + '…' : raw;
  } catch {
    return undefined;
  }
}

/**
 * Honest, actionable failure text for a mid-turn crash. The generic
 * "internal error" wording used to hide credential failures — a dead
 * provider key made EVERY tool turn look silently broken with no hint
 * that the fix belongs to the site owner, not the user.
 */
export function agentFailureMessage(detail: string): string {
  if (/credentials|401|403/i.test(detail)) {
    return 'I could not do any work this turn: the AI layer rejected its credentials (the provider key is missing, invalid or expired). Nothing was changed — the site owner needs to set a valid provider key, then this task will run.';
  }
  if (/429|rate.?limit/i.test(detail)) {
    return 'The AI layer is rate-limited right now. Nothing was changed — give it a moment and send the task again.';
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|network/i.test(detail)) {
    return 'I could not reach the AI layer (network error). Nothing was changed — check the deployment\u2019s connection and send the task again.';
  }
  if (/insufficient|credit|billing/i.test(detail)) {
    return 'This turn stopped at the billing gate. Nothing was changed — top up in Billing and send the task again.';
  }
  return 'Something went wrong inside the agent mid-turn. Nothing was published; send the task again — if it keeps failing, the site owner can find the cause in the logs (AGENT_TURN_FAILED).';
}

// ---------------------------------------------------------------------------
// The turn
// ---------------------------------------------------------------------------

export interface AgentTurnInput {
  userId: string;
  sessionId: string;
  userText: string;
  /** True when the user clicked the explicit approval control this turn. */
  userConfirmed?: boolean;
  /** File ids attached THIS turn (ownership-checked, same rule as chat). */
  attachmentIds?: string[];
  /** Request-resolved growth links — templates bake them at instantiation. */
  links?: GrowthLinks;
}

export interface AgentActivity {
  seq: number;
  tool: string;
  label: string;
  status: 'ok' | 'error' | 'confirm';
  detail?: string;
  /** Compact tool result fed back to the model (mirrors ExecRecord.data). */
  data?: unknown;
}

export interface AgentTurnResult {
  reply: string;
  activity: AgentActivity[];
  needsConfirm: boolean;
  draftBotId?: string | null;
  error?: string;
}

/** One full agent turn: model ⇄ tools loop, persisted. Never throws. */
export async function runBotBuilderTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
  const ctx: ToolContext = {
    userId: input.userId,
    sessionId: input.sessionId,
    userConfirmed: Boolean(input.userConfirmed),
    links: input.links,
  };

  const session = await db.chatSession.findFirst({
    where: { id: input.sessionId, userId: input.userId, kind: 'agent' },
  });
  if (!session) {
    return { reply: '', activity: [], needsConfirm: false, error: 'Agent session not found' };
  }
  const state = parseAgentState(session.state);

  // Same turn budget as chat — one shared politeness layer.
  const rl = rateLimit(`agent-turn:${input.userId}`, TURN_LIMIT, TURN_WINDOW_MS);
  if (!rl.allowed) {
    return {
      reply: '',
      activity: [],
      needsConfirm: false,
      error: `Too fast — try again in ${rl.retryAfter}s.`,
    };
  }

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
      error: 'The AI layer has no key configured yet. The site owner must add one first.',
    };
  }

  // Persist the user turn — but never an EMPTY one. Approval-only turns
  // ("Approve & publish" sends no text) would otherwise write a blank user
  // entry that renders as an empty bubble and pollutes model history; the
  // model already learns about the approval through the system prompt.
  const trimmedText = input.userText.trim().slice(0, 8000);

  // Resolve attachments with ownership checks (the chat rule, unchanged).
  const attachments: Array<{ fileId: string; name: string; kind: string }> = [];
  for (const fileId of (input.attachmentIds ?? []).slice(0, 5)) {
    const row = await db.userFile.findFirst({
      where: { id: fileId, userId: input.userId },
      select: { id: true, name: true, kind: true },
    });
    if (row) attachments.push({ fileId: row.id, name: row.name, kind: row.kind });
  }
  if (attachments.length) {
    // Attachments join the session's fileRefs so files_list and the system
    // prompt surface them on THIS and every later turn.
    await addFileRefs(session.id, attachments.map((a) => ({ fileId: a.fileId, name: a.name })));
    // Re-read so the final state write below preserves the merged refs.
    const refreshed = await db.chatSession.findUnique({ where: { id: session.id }, select: { state: true } });
    const merged = parseAgentState(refreshed?.state ?? null);
    if (merged.fileRefs) state.fileRefs = merged.fileRefs;
  }

  if (trimmedText || attachments.length) {
    await db.chatEntry.create({
      data: {
        sessionId: session.id,
        role: 'user',
        content: trimmedText,
        meta: attachments.length ? JSON.stringify({ attachments }) : null,
      },
    });
  }

  // Recent history for continuity.
  const historyRows = await db.chatEntry.findMany({
    where: { sessionId: session.id },
    orderBy: { createdAt: 'desc' },
    take: HISTORY_ENTRIES,
  });
  const history: ChatMessage[] = historyRows
    .reverse()
    .filter((e) => e.role === 'user' || e.role === 'assistant')
    .map((e) => ({
      role: e.role === 'assistant' ? 'assistant' : 'user',
      content: e.content.slice(0, 4000),
    }));

  const activity: AgentActivity[] = [];
  let seq = (await db.agentStep.count({ where: { sessionId: session.id } })) + 1;
  let draftBotId = state.draftBotId ?? null;
  let pendingApproval = state.pendingApproval ?? null;
  let finalMessage = '';

  /** Execute a batch of actions through the registry, tracking state. Returns
   *  how many ran (every action produces a record — unknown tools too). */
  const runActions = async (
    actions: Array<{ tool: string; args: Record<string, unknown> }>,
  ): Promise<number> => {
    let executed = 0;
    for (const action of actions) {
      // Unknown tools are executed through the registry too — executeTool
      // records them as errors so the audit trail stays complete.
      const record: ExecRecord = await executeTool(ctx, action.tool, action.args, seq++);
      activity.push({ seq: record.seq, tool: record.tool, label: record.label, status: record.status, detail: record.detail, data: record.data });

      // Track state transitions.
      if (action.tool === 'bot_create_draft' && record.status === 'ok') {
        // The tool result carries the new bot id in the AgentStep row; read it back cheaply.
        const step = await db.agentStep.findFirst({
          where: { sessionId: session.id, seq: record.seq },
          select: { resultJson: true },
        });
        if (step?.resultJson) {
          try {
            const data = JSON.parse(step.resultJson) as { botId?: string };
            if (data.botId) draftBotId = data.botId;
          } catch {
            /* ignore */
          }
        }
      }
      if (action.tool === 'bot_publish' && record.status === 'confirm') {
        pendingApproval = { tool: action.tool, botId: String((action.args as { botId?: string })?.botId ?? '') };
      }
      if (action.tool === 'bot_publish' && record.status === 'ok') {
        pendingApproval = null;
      }
      if (action.tool === 'bot_unpublish' && record.status === 'ok') {
        pendingApproval = null;
      }
      executed++;
    }
    return executed;
  };

  const resultsFeedback = (from: number): ChatMessage => {
    const resultsText = activity
      .slice(from)
      .map((a) => {
        const dataSuffix =
          a.data !== undefined
            ? ` | data: ${truncateForLog(typeof a.data === 'string' ? a.data : JSON.stringify(a.data), 600)}`
            : '';
        return `[${a.status}] ${a.tool}: ${a.label}${dataSuffix}`;
      })
      .join('\n');
    return { role: 'user', content: `TOOL RESULTS:\n${resultsText}\n\nContinue (JSON envelope only).` };
  };

  /** One billed model round. Returns the parsed envelope, or null when the
   *  billing gate stopped the turn. */
  const modelRound = async (messages: ChatMessage[]) => {
    // Pay-as-you-use: every builder round is one `ai_build` unit.
    try {
      const charge = await chargeFeature(input.userId, 'ai_build');
      if (charge.outcome === 'skipped') {
        finalMessage = finalMessage || `Out of credits — this turn needs ${formatUsd(charge.chargedMicros)}. Top up in Billing (Stars or crypto) and I will continue exactly where we stopped.`;
        return null;
      }
    } catch {
      /* billing outage → fail open */
    }
    const text = await selection.provider.generate(messages, {
      model: platformBot.model,
      temperature: 0.3, // agents want precision, not poetry
      maxTokens: Math.max(platformBot.maxTokens, AI_ROUND_TOKEN_FLOOR),
      apiKey: apiKey ?? selection.apiKey,
      baseUrl: selection.baseUrl,
    });
    return parseAgentReply(text);
  };

  // BR-034: tool results the model has not seen yet. The turn must not end
  // while this is true — that is how the agent used to "say working, then
  // stop": the budget ran out (or the model marked done) right after actions
  // executed, and the results were never reported.
  let pendingResults = false;

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const messages: ChatMessage[] = [
        { role: 'system', content: builderSystemPrompt({ ...state, draftBotId, pendingApproval }, Boolean(ctx.userConfirmed)) },
        ...history,
      ];

      const parsed = await modelRound(messages);
      pendingResults = false; // the model just saw the full history incl. any results
      if (!parsed) break; // billing gate — finalMessage already explains

      if (parsed.message) finalMessage = parsed.message;

      if (parsed.actions.length === 0) {
        // A round with no actions is the model's final word for this turn.
        break;
      }

      // BR-034: execute actions in EVERY round, regardless of the done flag.
      // Free models habitually set done:true (or omit it) while still listing
      // work — the old loop dropped all such actions from round 1 on, so the
      // agent did round 0 and froze mid-task.
      const before = activity.length;
      await runActions(parsed.actions);

      // Always feed results back — the model MUST see what happened before
      // the turn ends. done is advisory; results are not optional.
      history.push(resultsFeedback(before));
      pendingResults = true;
    }

    // Budget exhausted with unreported results → ONE wrap-up round so the
    // turn ends with a real report instead of a stale "Working on it…".
    if (pendingResults) {
      history.push({
        role: 'user',
        content:
          'ROUND BUDGET REACHED. Give your final answer NOW based on the tool results above: state what is done, what failed, and what you still need. Do not start new tool work unless it is essential; if more work remains, tell the user to send "continue".',
      });
      const messages: ChatMessage[] = [
        { role: 'system', content: builderSystemPrompt({ ...state, draftBotId, pendingApproval }, Boolean(ctx.userConfirmed)) },
        ...history,
      ];
      const parsed = await modelRound(messages);
      pendingResults = false;
      if (parsed) {
        if (parsed.message) finalMessage = parsed.message;
        const before = activity.length;
        const executed = await runActions(parsed.actions);
        if (executed > 0) {
          // The wrap-up did more work; its results are unreported by design
          // (hard budget). Be honest instead of pretending the turn closed.
          history.push(resultsFeedback(before));
        }
      }
      finalMessage =
        (finalMessage ? `${finalMessage}\n\n` : '') +
        '(Round budget reached — if anything is still unfinished, send "continue" and I will pick up exactly where I stopped.)';
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await db.log
      .create({
        data: {
          botId: null,
          level: 'error',
          event: 'AGENT_TURN_FAILED',
          message: truncateForLog(`session=${session.id} — ${detail}`),
        },
      })
      .catch(() => undefined);
    // BR-03x: a failed turn used to return WITHOUT persisting anything — the
    // user bubble stayed, the assistant side vanished on reload, and the
    // generic "internal error" text hid actionable causes (a dead provider
    // key made EVERY tool turn look silently broken). Persist the failed
    // turn like any other and say what actually happened.
    const reply = finalMessage.trim() || agentFailureMessage(detail);
    try {
      await db.chatSession.update({
        where: { id: session.id },
        data: {
          lastMessageAt: new Date(),
          state: JSON.stringify({
            draftBotId,
            pendingApproval: pendingApproval,
            lastSummary: reply.slice(0, 500) || null,
            fileRefs: state.fileRefs ?? [],
          } satisfies AgentState),
        },
      });
      await db.chatEntry.create({
        data: {
          sessionId: session.id,
          role: 'assistant',
          content: reply,
          meta: JSON.stringify({
            activity: activity.map((a) => ({
              seq: a.seq,
              tool: a.tool,
              label: a.label,
              status: a.status,
              detail: a.detail,
              dataPreview: toolDataPreview(a.data),
            })),
            needsConfirm: Boolean(pendingApproval),
            draftBotId,
          }),
        },
      });
    } catch {
      /* failure persistence is best-effort; the response still carries the error */
    }
    return {
      reply,
      activity,
      needsConfirm: Boolean(pendingApproval),
      draftBotId,
      error: sanitizeForLog(detail),
    };
  }

  // BR-034: a turn must never end in silence. An empty final message used to
  // persist as a blank assistant bubble — the user saw "working…" and then
  // literally nothing.
  if (!finalMessage.trim()) {
    finalMessage = activity.length
      ? 'I ran the steps above, but my final reply came back empty. Send "continue" (or restate the task) and I will pick it up from here.'
      : 'I could not produce a reply for that turn — please send it again.';
  }

  // Persist task state + the assistant entry with its activity feed.
  const needsConfirm = activity.some((a) => a.status === 'confirm');
  const nextState: AgentState = {
    draftBotId,
    pendingApproval: needsConfirm ? pendingApproval : null,
    lastSummary: finalMessage.slice(0, 500) || null,
    fileRefs: state.fileRefs ?? [],
  };
  await db.chatSession.update({
    where: { id: session.id },
    data: {
      state: JSON.stringify(nextState),
      lastMessageAt: new Date(),
      title:
        session.title === 'New chat' && input.userText.trim()
          ? input.userText.trim().slice(0, 60)
          : session.title,
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
        draftBotId,
      }),
    },
  });

  return { reply: finalMessage, activity, needsConfirm, draftBotId };
}

// ---------------------------------------------------------------------------
// Session bootstrap (used by the handoff flow and the /chats/agents UI)
// ---------------------------------------------------------------------------

/**
 * Create an agent session. The task itself is NOT written here — the caller
 * passes it to runBotBuilderTurn, which persists it as the session's first
 * USER entry (one visible task message, exactly like the chat flow; a second
 * system copy used to render the task twice and hid the file note from the
 * model). File references travel in session state and reach the model via
 * the system prompt.
 */
export async function ensureAgentSession(
  userId: string,
  opts: { agent: 'bot-builder'; title?: string; task?: string; fileRefs?: Array<{ fileId: string; name: string }> },
): Promise<string> {
  const session = await db.chatSession.create({
    data: {
      userId,
      kind: 'agent',
      agent: opts.agent,
      title: (opts.title || 'Bot build').slice(0, 60),
      state: JSON.stringify({
        fileRefs: (opts.fileRefs ?? []).slice(0, 8),
      } satisfies AgentState & { fileRefs?: unknown }),
    },
  });
  return session.id;
}

/**
 * The user's most recent active agent session (for handoff CONTINUATION).
 * Building is one ongoing workspace per user, not a new thread per request:
 * when the chat hands over a new task within 7 days of the last build, it
 * continues the existing agent session so the draft-bot state, file refs and
 * conversation memory stay in one place.
 */
export async function latestActiveAgentSession(userId: string): Promise<string | null> {
  const row = await db.chatSession.findFirst({
    where: {
      userId,
      kind: 'agent',
      agent: 'bot-builder',
      status: 'active',
      updatedAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
    },
    orderBy: { lastMessageAt: 'desc' },
    select: { id: true },
  });
  return row?.id ?? null;
}

/** Merge file references into an agent session's state (idempotent). */
export async function addFileRefs(sessionId: string, refs: Array<{ fileId: string; name: string }>): Promise<void> {
  const session = await db.chatSession.findUnique({ where: { id: sessionId }, select: { state: true } });
  if (!session) return;
  const state = parseAgentState(session.state);
  const existing = new Set((state.fileRefs ?? []).map((f) => f.fileId));
  const merged = [...(state.fileRefs ?? [])];
  for (const ref of refs) {
    if (!existing.has(ref.fileId)) {
      merged.push(ref);
      existing.add(ref.fileId);
    }
  }
  state.fileRefs = merged.slice(0, 8);
  await db.chatSession.update({ where: { id: sessionId }, data: { state: JSON.stringify(state) } });
}
