/**
 * NURAE — bot-scoped AI tools ("hands" for a bot's own AI).
 *
 * The free-text AI fallback / "Ask the AI" steps can go beyond plain chat:
 * when the bot's provider supports native function calling, the model may
 * call a SMALL registry of tools scoped to THIS bot and THIS chat:
 *
 *   remember_user_fact — write one per-user attribute (the same store the
 *                        collect/remember steps use, so {{placeholders}}
 *                        and flows see it)
 *   recall_user_info   — read back what the bot knows about this user
 *   list_bot_commands  — the bot's registered commands and flows, so the AI
 *                        guides users to real entry points instead of
 *                        improvising parallel ones
 *   notify_owner       — push a short alert into the owner's Telegram
 *                        (best-effort; requires a linked owner chat)
 *
 * Security model (mirrors the agent tool layer):
 *   - scope is structural: tools only ever touch ctx.bot.id + ctx.chatId;
 *   - argument size limits mirror the attribute store's own caps;
 *   - reserved attribute prefixes ("_", "paid_") are unwritable;
 *   - every invocation is logged (BOT_TOOL event) for the audit trail.
 */

import type { AIProvider, AIRequestConfig, ChatMessage } from '../ai/types';
import type { RuntimeBotRecord, RuntimeStore } from './store';
import { sendOwnerAlert } from '../bots/owner-notify';
import { truncateForLog } from '../sanitize';

export interface BotToolContext {
  bot: RuntimeBotRecord;
  chatId: string;
  store: RuntimeStore;
  /** Display name of the chatting user (alerts only — never persisted). */
  userName?: string;
}

export interface BotToolSpec {
  name: string;
  description: string;
  /** JSON-schema object for the model's function-calling surface. */
  parameters: Record<string, unknown>;
  exec(ctx: BotToolContext, args: Record<string, unknown>): Promise<{ label: string; data?: unknown }>;
}

/** Reserved attribute namespaces (internal flow state / billing). */
const RESERVED_ATTRIBUTE = /^(_|paid_)/;
const MAX_TOOL_CALLS_PER_TURN = 4;

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

const BOT_TOOLS: BotToolSpec[] = [
  {
    name: 'remember_user_fact',
    description:
      'Remember one durable fact about THIS user (e.g. favorite color, timezone, preference). Overwrites the same key.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Short slug, e.g. "favorite_color"' },
        value: { type: 'string', description: 'The fact to remember' },
      },
      required: ['key', 'value'],
    },
    async exec(ctx, args) {
      const key = str(args.key).toLowerCase().replace(/\s+/g, '_').slice(0, 64);
      const value = str(args.value).slice(0, 2000);
      if (!key || !value) return { label: 'Skipped — remember needs a key and a value' };
      if (RESERVED_ATTRIBUTE.test(key)) return { label: `Skipped — "${key}" is a reserved attribute` };
      await ctx.store.updateUserState(ctx.bot.id, ctx.chatId, { attributes: { [key]: value }, touch: true });
      return { label: `Remembered ${key} for this user`, data: { key, value } };
    },
  },
  {
    name: 'recall_user_info',
    description: 'Recall what this bot knows about THIS user: remembered facts and collected answers.',
    parameters: { type: 'object', properties: {} },
    async exec(ctx) {
      const state = await ctx.store.getUserState(ctx.bot.id, ctx.chatId);
      const attrs = Object.fromEntries(
        Object.entries(state?.attributes ?? {}).filter(([k]) => !RESERVED_ATTRIBUTE.test(k)),
      );
      const known = Object.keys(attrs).length;
      return {
        label: known ? `Recalled ${known} stored fact(s)` : 'Nothing stored about this user yet',
        data: attrs,
      };
    },
  },
  {
    name: 'list_bot_commands',
    description:
      "List this bot's registered Telegram commands and named flows, so you can guide the user to them.",
    parameters: { type: 'object', properties: {} },
    async exec(ctx) {
      const commands = (ctx.bot.capabilities?.commands ?? []).map((c) => ({
        command: c.command,
        description: c.description,
      }));
      const flows = (ctx.bot.capabilities?.replies ?? []).map((r) => ({
        name: r.name,
        trigger: r.trigger?.type,
      }));
      return {
        label: `Listed ${commands.length} command(s), ${flows.length} flow(s)`,
        data: { commands, flows },
      };
    },
  },
  {
    name: 'notify_owner',
    description:
      "Send the bot's owner a short, important alert in their own Telegram (e.g. \"a user asked for a refund\"). Use sparingly.",
    parameters: {
      type: 'object',
      properties: { message: { type: 'string', description: 'One short paragraph' } },
      required: ['message'],
    },
    async exec(ctx, args) {
      const message = str(args.message).slice(0, 1000);
      if (!message) return { label: 'Skipped — empty owner alert' };
      if (!ctx.bot.ownerChatId) return { label: 'Owner not reachable (no owner chat linked)' };
      const res = await sendOwnerAlert(ctx.bot.id, {
        title: `${ctx.bot.name} — AI relayed a message`,
        lines: [message, '', `From: ${ctx.userName ?? `chat ${ctx.chatId}`}`],
      });
      return {
        label: res.sent ? 'Owner notified' : `Owner alert failed (${res.error ?? 'unknown'})`,
        data: { sent: res.sent },
      };
    },
  },
];

/** OpenAI-style tool definitions for the model's function-calling surface. */
export function botToolDefs(): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
  return BOT_TOOLS.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
}

/** Execute one tool call by name. Unknown tools return a clean error result. */
export async function executeBotTool(
  ctx: BotToolContext,
  name: string,
  rawArgs: unknown,
): Promise<{ ok: boolean; label: string; data?: unknown }> {
  const tool = BOT_TOOLS.find((t) => t.name === name);
  if (!tool) return { ok: false, label: `Unknown bot tool: ${truncateForLog(name, 60)}` };
  let args: Record<string, unknown> = {};
  if (typeof rawArgs === 'string' && rawArgs.trim()) {
    try {
      args = JSON.parse(rawArgs) as Record<string, unknown>;
    } catch {
      args = {};
    }
  } else if (rawArgs && typeof rawArgs === 'object') {
    args = rawArgs as Record<string, unknown>;
  }
  try {
    const out = await tool.exec(ctx, args);
    await ctx.store
      .createLog(ctx.bot.id, 'info', `Bot tool ${name}: ${out.label}`, 'BOT_TOOL')
      .catch(() => undefined);
    return { ok: true, label: out.label, data: out.data };
  } catch (err) {
    const label = `Tool failed: ${err instanceof Error ? err.message : String(err)}`;
    await ctx.store
      .createLog(ctx.bot.id, 'error', `Bot tool ${name}: ${label}`, 'BOT_TOOL')
      .catch(() => undefined);
    return { ok: false, label };
  }
}

/**
 * Run the AI turn with bot tools when the provider supports native function
 * calling: the first round may return tool_calls; results are fed back and
 * ONE final plain-generate round writes the actual Telegram reply. A model
 * that answers without tools behaves exactly like the plain generate path.
 * The caller meters the turn once — the follow-up round is part of it.
 */
export async function runWithBotTools(
  provider: AIProvider,
  messages: ChatMessage[],
  config: AIRequestConfig,
  ctx: BotToolContext,
): Promise<string> {
  if (typeof provider.generateWithTools !== 'function') {
    return provider.generate(messages, config);
  }
  const first = await provider.generateWithTools(messages, { ...config, tools: botToolDefs() });
  if (first.toolCalls.length === 0) return first.content;

  const results: string[] = [];
  for (const call of first.toolCalls.slice(0, MAX_TOOL_CALLS_PER_TURN)) {
    const out = await executeBotTool(ctx, call.name, call.arguments);
    results.push(`[${call.name}] ${out.label}${out.data !== undefined ? ` → ${JSON.stringify(out.data).slice(0, 500)}` : ''}`);
  }
  const followUp: ChatMessage[] = [
    ...messages,
    { role: 'assistant', content: first.content || '(used bot tools)' },
    {
      role: 'user',
      content: `TOOL RESULTS:\n${results.join('\n')}\n\nNow write your final reply to the user as plain text. Use what the tools returned; do not mention tool names.`,
    },
  ];
  return provider.generate(followUp, { ...config, tools: undefined });
}
