/**
 * NURAE — bot capabilities: menu commands, response rules, inline buttons,
 * mini-workflows. The configuration model that agents write through tools
 * and the Telegram pipeline executes.
 *
 * Storage: two JSON strings on the Bot row (SQLite has no JSON type). All
 * shapes are validated with zod at the boundary — a poisoned row cannot
 * reach the pipeline (it re-validates on load, like bot config does).
 *
 * Shapes (v1 — deliberately small, everything here actually works):
 *   commands: [{ command: "/pricing", description, kind: "static"|"ai", response? }]
 *     - registered with Telegram setMyCommands on bot start (menu)
 *     - static → the response text is sent; ai → the text goes through the
 *       bot's AI with the response as extra instruction
 *   replies: [{ id, name, trigger: {type, value}, messages: [{ text, buttons? }] }]
 *     - trigger command → exact command match (after Telegram's menu)
 *     - trigger keyword  → case-insensitive substring match
 *     - trigger button   → callback_data equal to `value`
 *     - trigger fallback → catch-all for unmatched text
 *     - messages with >1 entries form a mini workflow (sent in order)
 *     - buttons: [{ text, url? , callback? }] — rows of ≤8, ≤8 rows
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export const botCommandSchema = z.object({
  command: z
    .string()
    .trim()
    .regex(/^\/[a-zA-Z0-9_]{1,32}$/, 'Command must look like /name (letters, digits, underscore)'),
  description: z.string().trim().min(1).max(64),
  // static: reply with `response`. ai: feed `response` to the model as guidance.
  kind: z.enum(['static', 'ai']).default('static'),
  response: z.string().trim().max(4000).optional().default(''),
});

export const botCommandsSchema = z.array(botCommandSchema).max(20);

// ---------------------------------------------------------------------------
// Replies / buttons / workflows
// ---------------------------------------------------------------------------

export const replyButtonSchema = z
  .object({
    text: z.string().trim().min(1).max(64),
    url: z.string().trim().url('Button URL must be valid').max(256).optional(),
    // Callback data ≤ 64 bytes (Telegram limit). Must be namespaced to the reply.
    callback: z.string().trim().max(64).optional(),
  })
  .refine((b) => Boolean(b.url || b.callback), { message: 'A button needs a URL or a callback' });

export const replyMessageSchema = z.object({
  text: z.string().trim().min(1).max(4000),
  buttons: z.array(z.array(replyButtonSchema).max(8)).max(8).optional(),
});

export const replyTriggerSchema = z.object({
  type: z.enum(['command', 'keyword', 'button', 'fallback']),
  value: z.string().trim().max(64).optional(),
});

export const botReplySchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    name: z.string().trim().min(1).max(100),
    trigger: replyTriggerSchema,
    messages: z.array(replyMessageSchema).min(1).max(10),
  })
  .refine(
    (r) =>
      r.trigger.type === 'fallback' ||
      (r.trigger.value !== undefined && r.trigger.value.length > 0),
    { message: 'This trigger type needs a value' },
  )
  .refine(
    // Button triggers must be namespaced so callbacks can never collide
    // between replies or with other bots on shared callback data.
    (r) => r.trigger.type !== 'button' || (r.trigger.value ?? '').startsWith('r:'),
    { message: 'Button callback data must start with "r:" (namespaced callback)' },
  );

export const botRepliesSchema = z.array(botReplySchema).max(30);

export type BotCommandSpec = z.infer<typeof botCommandSchema>;
export type BotReplySpec = z.infer<typeof botReplySchema>;
export type BotReplyButton = z.infer<typeof replyButtonSchema>;

// ---------------------------------------------------------------------------
// Serialize / load
// ---------------------------------------------------------------------------

export interface BotCapabilities {
  commands: BotCommandSpec[];
  replies: BotReplySpec[];
}

/** Validate + serialize capabilities into the two storage strings. */
export function serializeCapabilities(caps: Partial<BotCapabilities>): {
  commandsJson: string | null;
  repliesJson: string | null;
} {
  const commands = caps.commands?.length ? botCommandsSchema.parse(caps.commands) : [];
  const replies = caps.replies?.length ? botRepliesSchema.parse(caps.replies) : [];
  return {
    commandsJson: commands.length ? JSON.stringify(commands) : null,
    repliesJson: replies.length ? JSON.stringify(replies) : null,
  };
}

/** Load + validate capabilities from a Bot row. Corrupt rows degrade to empty. */
export function loadCapabilities(row: {
  commandsJson: string | null;
  repliesJson: string | null;
}): BotCapabilities {
  let commands: BotCommandSpec[] = [];
  let replies: BotReplySpec[] = [];
  try {
    if (row.commandsJson) commands = botCommandsSchema.parse(JSON.parse(row.commandsJson));
  } catch {
    commands = [];
  }
  try {
    if (row.repliesJson) replies = botRepliesSchema.parse(JSON.parse(row.repliesJson));
  } catch {
    replies = [];
  }
  return { commands, replies };
}

/** Telegram setMyCommands payload (menu shown in the client). */
export function telegramMenuCommands(commands: BotCommandSpec[]): Array<{
  command: string;
  description: string;
}> {
  return commands.map((c) => ({
    command: c.command.replace(/^\//, '').slice(0, 32),
    description: c.description.slice(0, 64),
  }));
}
