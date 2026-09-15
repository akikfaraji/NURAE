/**
 * NURAE — bot capabilities: menu commands, response rules, keyboards, media,
 * polls, payments, forms. The configuration model that agents write through
 * tools and the Telegram pipeline executes.
 *
 * Storage: two JSON strings on the Bot row (SQLite has no JSON type). All
 * shapes are validated with zod at the boundary — a poisoned row cannot
 * reach the pipeline (it re-validates on load, like bot config does).
 *
 * Shapes (v2 — the full interaction surface):
 *   commands: [{ command: "/pricing", description, kind: "static"|"ai", response? }]
 *     - registered with Telegram setMyCommands on bot start (menu)
 *     - static → the response text is sent; ai → the text goes through the
 *       bot's AI with the response as extra instruction
 *   replies: [{ id, name, trigger: {type, value}, messages: [ReplyMessage] }]
 *     - remember/draw/top steps: silent attribute writes, random draws over
 *       an attribute's holders, leaderboards — the promotion primitives
 *     - trigger command   → exact command match (after Telegram's menu)
 *     - trigger keyword   → case-insensitive substring match
 *     - trigger text      → exact (case-insensitive) match — reply keyboards
 *     - trigger button    → callback_data equal to `value` (r: namespaced)
 *     - trigger payload   → /start deep-link payload (exact or prefix)
 *     - trigger member_joined → group join service messages
 *     - trigger fallback  → catch-all for unmatched text
 *     - messages with >1 entries form a mini workflow (sent in order);
 *       collect/schedule steps pause the flow until the user answers
 *   replyMessage: { text, ai?, buttons?, media?, poll?, location?, payment?,
 *                   collect?, schedule?, edit?, keyboard?, forceReply?, removeKeyboard? }
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
// Buttons — inline (url/callback/webapp/copy) and reply-keyboard labels
// ---------------------------------------------------------------------------

export const replyButtonSchema = z
  .object({
    text: z.string().trim().min(1).max(64),
    url: z.string().trim().url('Button URL must be valid').max(256).optional(),
    // Callback data ≤ 64 bytes (Telegram limit). Must be namespaced to the reply.
    callback: z.string().trim().max(64).optional(),
    // Mini App button — opens the web app inside Telegram (HTTPS only).
    webapp: z.string().trim().url('Mini App URL must be valid').max(256).optional(),
    // copy_text button — pressing copies the text (Bot API 7.11).
    copy: z.string().trim().min(1).max(200).optional(),
  })
  .refine((b) => Boolean(b.url || b.callback || b.webapp || b.copy), {
    message: 'A button needs a URL, a callback, a Mini App URL, or text to copy',
  });

// ---------------------------------------------------------------------------
// Message steps — the full outbound surface
// ---------------------------------------------------------------------------

export const replyMediaSchema = z.object({
  // photo | video | audio | voice | animation | document | sticker
  kind: z.enum(['photo', 'video', 'audio', 'voice', 'animation', 'document', 'sticker']),
  // HTTPS URL (Telegram fetches it) or a persistent file_id.
  source: z
    .string()
    .trim()
    .min(6)
    .max(512)
    .refine((s) => /^https?:\/\//i.test(s) || /^[\w-]{20,}$/.test(s) || /^[\w-]+$/.test(s), {
      message: 'Media source must be an HTTPS URL or a Telegram file_id',
    }),
  caption: z.string().trim().max(1024).optional(),
  filename: z.string().trim().max(120).optional(),
});

export const replyPollSchema = z
  .object({
    question: z.string().trim().min(1).max(300),
    options: z.array(z.string().trim().min(1).max(100)).min(2).max(12),
    quiz: z.boolean().optional(),
    correctOption: z.number().int().min(0).max(11).optional(),
    explanation: z.string().trim().max(200).optional(),
    anonymous: z.boolean().optional(),
  })
  .refine((p) => !p.quiz || typeof p.correctOption === 'number', {
    message: 'A quiz needs a correct option',
  });

export const replyLocationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  title: z.string().trim().max(64).optional(),
  address: z.string().trim().max(64).optional(),
});

// Stars invoice — the mandatory rail for digital goods inside Telegram.
export const replyPaymentSchema = z.object({
  title: z.string().trim().min(1).max(32),
  description: z.string().trim().min(1).max(255),
  priceStars: z.number().int().min(1).max(25_000),
  // Stable key stored on the payment row + user attribute (paid_<payload>).
  // Auto-derived per step when omitted.
  payload: z.string().trim().max(128).optional(),
  // Sent automatically after successful_payment for this product.
  successText: z.string().trim().max(4000).optional(),
});

// "Ask and remember" — pauses the flow; the next text answer is stored.
export const replyCollectSchema = z.object({
  attribute: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9_-]{1,40}$/, 'Attribute names are short slugs (letters, digits, "-", "_")'),
  prompt: z.string().trim().max(1000).optional(),
});

// "Set a reminder" — pauses the flow; the answer is parsed into a schedule
// with the bot's own AI ("tomorrow at 9am" → a real scheduled message).
export const replyScheduleSchema = z.object({
  prompt: z.string().trim().max(1000).optional(),
});

// "Remember" — silently set (or add to) an attribute. The quiet workhorse of
// referral counters, giveaway entries, quiz scores and subscription flags.
export const replyRememberSchema = z.object({
  attribute: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9_-]{1,40}$/, 'Attribute names are short slugs (letters, digits, "-", "_")'),
  // Any text value; numbers may arrive as strings.
  value: z.string().trim().max(2000).default(''),
  // set → overwrite; add → numeric increment (missing counts as 0).
  mode: z.enum(['set', 'add']).default('set'),
});

// "Draw a winner" — picks a random user who holds `attribute` and announces.
// The announce text is templated with {{winner}}, {{winner_name}} and
// {{count}}; an honest no-entrants message is sent when nobody qualifies.
export const replyDrawSchema = z.object({
  attribute: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9_-]{1,40}$/, 'Attribute names are short slugs (letters, digits, "-", "_")'),
  announce: z.string().trim().max(4000).default('🎉 The winner is {{winner_name}} ({{winner_chat}}) — {{count}} entrant(s). Congratulations!'),
  // Sent instead of the announce when nobody holds the attribute.
  emptyText: z.string().trim().max(1000).default('No entrants yet — nobody to draw from.'),
});

// "Leaderboard" — ranks users by a numeric attribute (desc) and posts the
// top `limit`, medaling the first three. Values that are not numbers sort
// as 0 (honest: text attributes do not belong on a leaderboard).
export const replyTopSchema = z.object({
  attribute: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9_-]{1,40}$/, 'Attribute names are short slugs (letters, digits, "-", "_")'),
  title: z.string().trim().max(200).default('Leaderboard'),
  limit: z.number().int().min(1).max(20).default(10),
});

// "Join gate" — verify the user is a member of a public chat before the
// flow continues; non-members get the prompt + t.me button and the flow
// pauses (re-press after joining). The pipeline fails open on any error.
export const replyVerifyJoinSchema = z.object({
  chat: z
    .string()
    .trim()
    .regex(/^@[a-zA-Z0-9_]{4,64}$/, 'The channel handle looks like @username (a public chat the bot can verify).'),
  prompt: z.string().trim().max(1000).default('One quick step: join our channel, then tap the button again.'),
  buttonText: z.string().trim().max(64).default('Join the channel'),
  url: z.string().trim().url().max(256),
});

// "Daily streak" — silently maintains <attribute> (current), <attribute>_best
// (record) and <attribute>_date (UTC day). Show it with {{attribute}}.
export const replyStreakSchema = z.object({
  attribute: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9_-]{1,40}$/, 'Attribute names are short slugs (letters, digits, "-", "_")'),
});

// "Milestone" — the first time a counter reaches `value`, send `message`
// (with optional buttons) exactly once; the flag <attribute>_m<value> marks
// the claim. Otherwise the step is silent and the flow just continues.
export const replyMilestoneSchema = z.object({
  attribute: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9_-]{1,40}$/, 'Attribute names are short slugs (letters, digits, "-", "_")'),
  value: z.number().int().min(1).max(1_000_000),
  message: z.string().trim().min(1).max(2000),
  buttons: z.array(z.array(replyButtonSchema).max(8)).max(8).optional(),
});

// "Email invite" — records the consent row and mails the invitation.
export const replyEmailInviteSchema = z.object({
  attribute: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9_-]{1,40}$/, 'Attribute names are short slugs (letters, digits, "-", "_")'),
  successText: z.string().trim().max(2000),
  failText: z.string().trim().max(2000),
  alreadyText: z.string().trim().max(2000),
  queuedText: z.string().trim().max(2000),
});

// "Email stop" — permanent unsubscribe for this chat's address.
export const replyEmailUnsubscribeSchema = z.object({
  confirmText: z.string().trim().max(2000),
  nothingText: z.string().trim().max(2000),
});

export const replyMessageSchema = z.object({
  text: z.string().trim().max(4000).default(''),
  buttons: z.array(z.array(replyButtonSchema).max(8)).max(8).optional(),
  // Behavior "Ask the AI" steps compile to this marker: the pipeline runs the
  // bot's AI with `ai` as extra guidance instead of sending `text` verbatim.
  // Text still carries the trigger label (buttons need non-empty message text).
  ai: z.string().trim().max(2000).optional(),
  media: replyMediaSchema.optional(),
  poll: replyPollSchema.optional(),
  location: replyLocationSchema.optional(),
  payment: replyPaymentSchema.optional(),
  collect: replyCollectSchema.optional(),
  schedule: replyScheduleSchema.optional(),
  remember: replyRememberSchema.optional(),
  draw: replyDrawSchema.optional(),
  top: replyTopSchema.optional(),
  verifyJoin: replyVerifyJoinSchema.optional(),
  streak: replyStreakSchema.optional(),
  milestone: replyMilestoneSchema.optional(),
  emailInvite: replyEmailInviteSchema.optional(),
  emailUnsubscribe: replyEmailUnsubscribeSchema.optional(),
  // Edit the pressed button's message in place instead of sending a new one
  // (the idiomatic UX for pagination/settings/carts). Callback turns only.
  edit: z.boolean().optional(),
  // Render buttons as a reply keyboard (labels sent back as text) or strip.
  keyboard: z.enum(['inline', 'reply', 'none']).optional(),
  forceReply: z.boolean().optional(),
  removeKeyboard: z.boolean().optional(),
});

export const replyTriggerSchema = z.object({
  type: z.enum(['command', 'keyword', 'text', 'button', 'fallback', 'payload', 'member_joined']),
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
      r.trigger.type === 'member_joined' ||
      (r.trigger.value !== undefined && r.trigger.value.length > 0),
    { message: 'This trigger type needs a value' },
  )
  .refine(
    // Button triggers must be namespaced so callbacks can never collide
    // between replies or with other bots on shared callback data.
    (r) => r.trigger.type !== 'button' || (r.trigger.value ?? '').startsWith('r:'),
    { message: 'Button callback data must start with "r:" (namespaced callback)' },
  )
  .refine(
    // A message step must DO something — the pipeline rejects empty sends.
    (r) =>
      r.messages.every(
        (m) =>
          m.text.trim().length > 0 ||
          m.ai !== undefined ||
          m.media !== undefined ||
          m.poll !== undefined ||
          m.location !== undefined ||
          m.payment !== undefined ||
          m.collect !== undefined ||
          m.schedule !== undefined ||
          m.remember !== undefined ||
          m.draw !== undefined ||
          m.top !== undefined ||
          m.verifyJoin !== undefined ||
          m.streak !== undefined ||
          m.milestone !== undefined ||
          m.emailInvite !== undefined ||
          m.emailUnsubscribe !== undefined,
      ),
    { message: 'Every message step needs text, media, a poll, a payment, or something to ask' },
  );

export const botRepliesSchema = z.array(botReplySchema).max(30);

export type BotCommandSpec = z.infer<typeof botCommandSchema>;
export type BotReplySpec = z.infer<typeof botReplySchema>;
export type BotReplyButton = z.infer<typeof replyButtonSchema>;
export type BotReplyMessage = z.infer<typeof replyMessageSchema>;

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

/**
 * Load + validate capabilities from a Bot row. Resilience contract: ONE
 * invalid rule (e.g. a button written by an older compiler whose shape today's
 * schema rejects) is dropped — it can NEVER take the whole bot's replies down
 * with it (an all-or-nothing parse muted entire bots: no /start, no buttons).
 * Corrupt JSON degrades to empty the same way as before.
 */
export function loadCapabilities(row: {
  commandsJson: string | null;
  repliesJson: string | null;
}): BotCapabilities {
  let commands: BotCommandSpec[] = [];
  let replies: BotReplySpec[] = [];
  try {
    if (row.commandsJson) {
      const raw: unknown = JSON.parse(row.commandsJson);
      if (Array.isArray(raw)) {
        for (const item of raw) {
          const parsed = botCommandSchema.safeParse(item);
          if (parsed.success) commands.push(parsed.data);
        }
      }
    }
  } catch {
    commands = [];
  }
  try {
    if (row.repliesJson) {
      const raw: unknown = JSON.parse(row.repliesJson);
      if (Array.isArray(raw)) {
        for (const item of raw) {
          const parsed = botReplySchema.safeParse(item);
          if (parsed.success) replies.push(parsed.data);
        }
      }
    }
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

/**
 * Stars compliance: any bot that sells digital goods must answer /terms,
 * /paysupport and /support. The compiler appends these automatically when a
 * payment step exists — unless the builder already defined them.
 */
export function complianceCommands(commands: BotCommandSpec[]): BotCommandSpec[] {
  const has = (name: string) =>
    commands.some((c) => c.command.toLowerCase() === `/${name}`);
  const extras: BotCommandSpec[] = [];
  if (!has('terms')) {
    extras.push({
      command: '/terms',
      description: 'Terms of service',
      kind: 'static',
      response:
        'Terms: digital goods and services delivered through this bot are sold via Telegram Stars. ' +
        'Prices are shown before you pay. If something you paid for was not delivered, contact /support — we make it right or refund.',
    });
  }
  if (!has('paysupport')) {
    extras.push({
      command: '/paysupport',
      description: 'Help with a payment',
      kind: 'static',
      response:
        'For payment issues: check that the payment went through in Telegram (Settings → Stars). ' +
        'If you were charged but did not receive the product, message /support with the payment date and we will refund or deliver.',
    });
  }
  if (!has('support')) {
    extras.push({
      command: '/support',
      description: 'Contact support',
      kind: 'static',
      response: 'Support: describe your issue here and the team will answer. Payment refunds are handled within 14 days.',
    });
  }
  return extras;
}
