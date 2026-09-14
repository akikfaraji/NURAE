/**
 * NURAE — Behaviors: the primary concept of bot building.
 *
 * A user (or an agent) describes WHAT the bot should do:
 *
 *     "When someone starts the bot, welcome them and give them buttons
 *      for Menu, Order, and Contact."
 *
 * …and the compiler below turns that into the technical configuration the
 * Telegram pipeline already executes (menu commands, reply rules, inline
 * keyboards, callback wiring, AI steps, media, polls, payments, forms,
 * reminders). Commands/callbacks/workflows stay real underneath — they are
 * simply not the language people build in.
 *
 * Layering (who owns what):
 *   behaviors_json   SOURCE OF TRUTH — edited by people and the agent
 *   commands_json    compiled artifact — executed by the pipeline
 *   replies_json     compiled artifact — executed by the pipeline
 *
 * Editing the artifacts by hand (the Advanced editors) still works; the next
 * behavior save recompiles and replaces them. That trade is stated in the UI.
 *
 * Everything here is validated with zod at the boundary. The compiler is
 * total: it either returns a valid BotCapabilities or throws a
 * BehaviorCompileError whose issues are human-readable.
 */

import { z } from 'zod';
import {
  botCommandsSchema,
  botRepliesSchema,
  complianceCommands,
  serializeCapabilities,
  type BotCapabilities,
  type BotCommandSpec,
  type BotReplySpec,
} from './capabilities';

// ---------------------------------------------------------------------------
// Schemas — the language people build in
// ---------------------------------------------------------------------------

const idPattern = /^[a-zA-Z0-9_-]{1,40}$/;

/**
 * What a button does — deliberately phrased the way a non-developer thinks:
 *   Show a message · Open a link · Open a Mini App · Copy text ·
 *   Start a flow · Ask the AI
 * (No "callback query", no "inline keyboard" — the compiler decides that.)
 */
export const behaviorButtonActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('message'), text: z.string().trim().min(1).max(4000) }),
  z.object({ kind: z.literal('link'), url: z.string().trim().url('Button URL must be valid').max(256) }),
  // Opens a Mini App inside Telegram (web_app button, HTTPS URL).
  z.object({ kind: z.literal('webapp'), url: z.string().trim().url('Mini App URL must be valid').max(256) }),
  // copy_text button — pressing copies the text.
  z.object({ kind: z.literal('copy'), text: z.string().trim().min(1).max(200) }),
  // Starts another behavior (by id). The compiler wires the callback.
  z.object({ kind: z.literal('flow'), behaviorId: z.string().trim().regex(idPattern) }),
  // Hands the turn to the bot's AI, optionally with extra guidance.
  z.object({ kind: z.literal('ai'), instruction: z.string().trim().max(2000).optional() }),
]);

export const behaviorButtonSchema = z.object({
  label: z.string().trim().min(1).max(64),
  action: behaviorButtonActionSchema,
});

export const behaviorMediaSchema = z.object({
  kind: z.enum(['photo', 'video', 'audio', 'voice', 'animation', 'document', 'sticker']),
  source: z
    .string()
    .trim()
    .min(6)
    .max(512)
    .refine((s) => /^https?:\/\//i.test(s) || /^[\w-]+$/.test(s), {
      message: 'Media source must be an HTTPS URL or a Telegram file_id',
    }),
  caption: z.string().trim().max(1024).optional(),
  filename: z.string().trim().max(120).optional(),
});

export const behaviorPollSchema = z
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

export const behaviorPaymentSchema = z.object({
  title: z.string().trim().min(1).max(32),
  description: z.string().trim().min(1).max(255),
  priceStars: z.number().int().min(1).max(25_000),
  successText: z.string().trim().max(4000).optional(),
});

export const behaviorCollectSchema = z.object({
  attribute: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9_-]{1,40}$/, 'Attribute names are short slugs (letters, digits, "-", "_")'),
  prompt: z.string().trim().max(1000).optional(),
});

export const behaviorScheduleSchema = z.object({
  prompt: z.string().trim().max(1000).optional(),
});

// "Remember" — silently set (or numerically add to) an attribute.
export const behaviorRememberSchema = z.object({
  attribute: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9_-]{1,40}$/, 'Attribute names are short slugs (letters, digits, "-", "_")'),
  value: z.string().trim().max(2000).default(''),
  mode: z.enum(['set', 'add']).default('set'),
});

// "Draw a winner" — random pick among users holding an attribute.
export const behaviorDrawSchema = z.object({
  attribute: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9_-]{1,40}$/, 'Attribute names are short slugs (letters, digits, "-", "_")'),
  announce: z.string().trim().max(4000).default('🎉 The winner is {{winner_name}} ({{winner_chat}}) — {{count}} entrant(s). Congratulations!'),
  emptyText: z.string().trim().max(1000).default('No entrants yet — nobody to draw from.'),
});

// "Leaderboard" — top users by a numeric attribute.
export const behaviorTopSchema = z.object({
  attribute: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9_-]{1,40}$/, 'Attribute names are short slugs (letters, digits, "-", "_")'),
  title: z.string().trim().max(200).default('Leaderboard'),
  limit: z.number().int().min(1).max(20).default(10),
});

export const behaviorStepSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message'),
    text: z.string().trim().max(4000).default(''),
    buttons: z.array(behaviorButtonSchema).max(8).optional(),
    // reply = labels the user taps and sends back as text; none = no keyboard.
    keyboard: z.enum(['inline', 'reply', 'none']).optional(),
    // Replace the pressed button's message in place (callback turns only).
    edit: z.boolean().optional(),
    forceReply: z.boolean().optional(),
    removeKeyboard: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('ai'),
    instruction: z.string().trim().max(2000).optional(),
  }),
  // Send a photo/video/audio/voice/animation/document/sticker.
  z.object({
    type: z.literal('media'),
    media: behaviorMediaSchema,
    buttons: z.array(behaviorButtonSchema).max(8).optional(),
  }),
  // Run a poll / quiz.
  z.object({ type: z.literal('poll'), poll: behaviorPollSchema }),
  // Charge Telegram Stars for a digital product (compliance commands auto-added).
  z.object({ type: z.literal('payment'), payment: behaviorPaymentSchema }),
  // Ask a question and remember the answer ({{attribute}} usable everywhere).
  z.object({ type: z.literal('collect'), collect: behaviorCollectSchema }),
  // Ask when to remind, parse the answer with the bot's AI, schedule it.
  z.object({ type: z.literal('schedule'), schedule: behaviorScheduleSchema }),
  // Silently remember (or increment) an attribute — counters, flags, entries.
  z.object({ type: z.literal('remember'), remember: behaviorRememberSchema }),
  // Draw a random winner among the users holding an attribute.
  z.object({ type: z.literal('draw'), draw: behaviorDrawSchema }),
  // Post the leaderboard for a numeric attribute.
  z.object({ type: z.literal('top'), top: behaviorTopSchema }),
]);

export const behaviorWhenSchema = z.discriminatedUnion('type', [
  // "When someone starts the bot" (also produced from a /start command)
  z.object({ type: z.literal('start') }),
  // "When someone types /menu"
  z.object({ type: z.literal('command'), command: z.string().trim().regex(/^\/[a-zA-Z0-9_]{1,32}$/) }),
  // "When a message mentions 'price'"
  z.object({ type: z.literal('says'), text: z.string().trim().min(1).max(64) }),
  // "When a button is pressed" — usually the target of a "Start a flow" action
  z.object({ type: z.literal('button') }),
  // "When someone arrives from the link with payload …" (deep links)
  z.object({ type: z.literal('payload'), value: z.string().trim().min(1).max(64) }),
  // "When someone joins the group"
  z.object({ type: z.literal('member_joined') }),
  // "For anything else"
  z.object({ type: z.literal('anything_else') }),
]);

export const behaviorSchema = z.object({
  id: z.string().trim().regex(idPattern),
  title: z.string().trim().min(1).max(100),
  when: behaviorWhenSchema,
  steps: z.array(behaviorStepSchema).min(1).max(10),
});

export const botBehaviorsSchema = z.array(behaviorSchema).max(40);

export type BehaviorButtonAction = z.infer<typeof behaviorButtonActionSchema>;
export type BehaviorButton = z.infer<typeof behaviorButtonSchema>;
export type BehaviorStep = z.infer<typeof behaviorStepSchema>;
export type BehaviorWhen = z.infer<typeof behaviorWhenSchema>;
export type BotBehaviorSpec = z.infer<typeof behaviorSchema>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class BehaviorCompileError extends Error {
  issues: string[];
  constructor(issues: string[]) {
    // The issues ARE the message — callers surface it directly to people.
    super(`Behaviors could not be compiled: ${issues.join(' ')}`);
    this.name = 'BehaviorCompileError';
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------
// Serialize / load
// ---------------------------------------------------------------------------

/** Validate + serialize behaviors into the storage string. Empty ⇒ null. */
export function serializeBehaviors(behaviors: BotBehaviorSpec[]): string | null {
  const list = behaviors?.length ? botBehaviorsSchema.parse(behaviors) : [];
  return list.length ? JSON.stringify(list) : null;
}

/** Load + validate behaviors from a Bot row. Corrupt rows degrade to empty. */
export function loadBehaviors(row: { behaviorsJson: string | null }): BotBehaviorSpec[] {
  if (!row.behaviorsJson) return [];
  try {
    return botBehaviorsSchema.parse(JSON.parse(row.behaviorsJson));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// The compiler — behaviors → commands + replies
// ---------------------------------------------------------------------------

/** Callback data is capped at 64 bytes by Telegram; keep generated ids short. */
const BTN_PREFIX = 'r:a'; // synthesized button-action rules
const FLOW_PREFIX = 'r:b'; // button-trigger behaviors

interface Ctx {
  commands: BotCommandSpec[];
  replies: BotReplySpec[];
  issues: string[];
  hasPayment: boolean;
}

function callbackForAction(behaviorId: string, stepIdx: number, btnIdx: number): string {
  // e.g. r:a_welcome_0_1 — deterministic so recompiles keep stable callbacks.
  return `${BTN_PREFIX}_${behaviorId}_${stepIdx}_${btnIdx}`;
}

function callbackForBehavior(behaviorId: string): string {
  return `${FLOW_PREFIX}_${behaviorId}`;
}

function buttonToReplyButton(b: BehaviorButton): { text: string; url?: string; callback?: string; webapp?: string; copy?: string } {
  const a = b.action;
  if (a.kind === 'link') return { text: b.label, url: a.url };
  if (a.kind === 'webapp') return { text: b.label, webapp: a.url };
  if (a.kind === 'copy') return { text: b.label, copy: a.text };
  return { text: b.label }; // callback filled by compileButton
}

function stepsToReplyMessages(
  behavior: BotBehaviorSpec,
  ctx: Ctx,
): BotReplySpec['messages'] {
  return behavior.steps.map((step, stepIdx) => {
    if (step.type === 'ai') {
      // An AI step inside a flow: the pipeline runs the bot's AI with the
      // instruction as extra guidance. `text` carries the trigger label for
      // logging; the schema requires it to be non-empty.
      return { text: behavior.title.slice(0, 64), ai: step.instruction ?? '' };
    }
    if (step.type === 'media') {
      const buttons = step.buttons?.length ? [step.buttons.map((b, btnIdx) => compileButton(b, behavior, stepIdx, btnIdx, ctx))] : undefined;
      return {
        text: '',
        media: { kind: step.media.kind, source: step.media.source, caption: step.media.caption, filename: step.media.filename },
        ...(buttons ? { buttons } : {}),
      };
    }
    if (step.type === 'poll') {
      return {
        text: '',
        poll: {
          question: step.poll.question,
          options: step.poll.options,
          quiz: step.poll.quiz,
          correctOption: step.poll.correctOption,
          explanation: step.poll.explanation,
          anonymous: step.poll.anonymous,
        },
      };
    }
    if (step.type === 'payment') {
      ctx.hasPayment = true;
      return {
        text: '',
        payment: {
          title: step.payment.title,
          description: step.payment.description,
          priceStars: step.payment.priceStars,
          // Deterministic payload: the key the pipeline stores + confirms on.
          payload: `p_${behavior.id}_${stepIdx}`.slice(0, 128),
          successText: step.payment.successText,
        },
      };
    }
    if (step.type === 'collect') {
      return {
        text: step.collect.prompt ?? '',
        collect: { attribute: step.collect.attribute, prompt: step.collect.prompt },
      };
    }
    if (step.type === 'schedule') {
      return {
        text: step.schedule.prompt ?? '',
        schedule: { prompt: step.schedule.prompt },
      };
    }
    if (step.type === 'remember') {
      return {
        text: '',
        remember: {
          attribute: step.remember.attribute,
          value: step.remember.value,
          mode: step.remember.mode,
        },
      };
    }
    if (step.type === 'draw') {
      return {
        text: '',
        draw: {
          attribute: step.draw.attribute,
          announce: step.draw.announce,
          emptyText: step.draw.emptyText,
        },
      };
    }
    if (step.type === 'top') {
      return {
        text: '',
        top: { attribute: step.top.attribute, title: step.top.title, limit: step.top.limit },
      };
    }
    // message step.
    const buttons = step.buttons?.length ? [step.buttons.map((b, btnIdx) => compileButton(b, behavior, stepIdx, btnIdx, ctx))] : undefined;
    return {
      text: step.text,
      ...(buttons ? { buttons } : {}),
      ...(step.keyboard ? { keyboard: step.keyboard } : {}),
      ...(step.edit ? { edit: true } : {}),
      ...(step.forceReply ? { forceReply: true } : {}),
      ...(step.removeKeyboard ? { removeKeyboard: true } : {}),
    };
  });
}

function compileButton(
  button: BehaviorButton,
  behavior: BotBehaviorSpec,
  stepIdx: number,
  btnIdx: number,
  ctx: Ctx,
): { text: string; url?: string; callback?: string; webapp?: string; copy?: string } {
  const action = button.action;
  switch (action.kind) {
    case 'link':
    case 'webapp':
    case 'copy':
      return buttonToReplyButton(button);
    case 'flow':
      // The target behavior's own button-trigger rule answers the press.
      return { text: button.label, callback: callbackForBehavior(action.behaviorId) };
    case 'message':
    case 'ai': {
      const callback = callbackForAction(behavior.id, stepIdx, btnIdx);
      ctx.replies.push({
        id: `a_${behavior.id}_${stepIdx}_${btnIdx}`.slice(0, 64),
        name: button.label,
        trigger: { type: 'button', value: callback },
        messages:
          action.kind === 'message'
            ? [{ text: action.text }]
            : [{ text: button.label, ai: action.instruction ?? '' }],
      });
      return { text: button.label, callback };
    }
  }
}

/** The plain-language trigger compiled into the technical trigger. */
function compileTrigger(behavior: BotBehaviorSpec): BotReplySpec['trigger'] {
  switch (behavior.when.type) {
    case 'start':
      return { type: 'command', value: '/start' };
    case 'command':
      return { type: 'command', value: behavior.when.command.toLowerCase() };
    case 'says':
      return { type: 'keyword', value: behavior.when.text };
    case 'button':
      return { type: 'button', value: callbackForBehavior(behavior.id) };
    case 'payload':
      return { type: 'payload', value: behavior.when.value };
    case 'member_joined':
      return { type: 'member_joined' };
    case 'anything_else':
      return { type: 'fallback' };
  }
}

/**
 * Compile behaviors into executable capabilities.
 *
 * Guarantees:
 *  - every generated reply/button passes botRepliesSchema (the pipeline's
 *    loader re-validates, so a bad compile can never poison a running bot);
 *  - flow actions point at behaviors that exist;
 *  - command triggers are unique (/start normalizes to a start behavior);
 *  - reply-keyboard buttons carry message/flow/AI actions only (Telegram
 *    reply keyboards send the label as text — links would be dead buttons);
 *  - menu commands exist for every command behavior so Telegram's / menu
 *    stays discoverable;
 *  - selling with a payment step auto-adds the /terms /paysupport /support
 *    compliance commands (Stars policy) unless already defined.
 */
export function compileBehaviors(behaviors: BotBehaviorSpec[]): BotCapabilities {
  const list = behaviors?.length ? botBehaviorsSchema.parse(behaviors) : [];
  const ctx: Ctx = { commands: [], replies: [], issues: [], hasPayment: false };

  const ids = new Set<string>();
  const commandValues = new Map<string, string>(); // "/start" → behavior title
  let hasStart = false;
  let hasFallback = false;

  // Pass 1: structural checks that need the whole list.
  for (const b of list) {
    if (ids.has(b.id)) ctx.issues.push(`Two behaviors share the id "${b.id}".`);
    ids.add(b.id);
    if (b.when.type === 'start' || (b.when.type === 'command' && b.when.command.toLowerCase() === '/start')) {
      if (hasStart) ctx.issues.push('More than one behavior claims "when someone starts the bot".');
      hasStart = true;
    }
    if (b.when.type === 'anything_else') {
      if (hasFallback) ctx.issues.push('More than one "anything else" behavior.');
      hasFallback = true;
    }
    if (b.when.type === 'command') {
      const key = b.when.command.toLowerCase();
      if (key !== '/start') {
        if (commandValues.has(key)) {
          ctx.issues.push(`The command ${key} is used by both "${commandValues.get(key)}" and "${b.title}".`);
        }
        commandValues.set(key, b.title);
      }
    }
  }
  // Flow targets must exist.
  for (const b of list) {
    for (const step of b.steps) {
      if (step.type !== 'message' || !step.buttons) continue;
      for (const button of step.buttons) {
        if (button.action.kind === 'flow' && !ids.has(button.action.behaviorId)) {
          ctx.issues.push(
            `Button "${button.label}" in "${b.title}" starts flow "${button.action.behaviorId}", which does not exist.`,
          );
        }
      }
    }
  }
  if (ctx.issues.length) throw new BehaviorCompileError(ctx.issues);

  // Pass 2: compile.
  for (const b of list) {
    const when = b.when.type === 'command' && b.when.command.toLowerCase() === '/start'
      ? ({ type: 'start' } as const)
      : b.when;
    const effective: BotBehaviorSpec = when === b.when ? b : { ...b, when };

    const messages = stepsToReplyMessages(effective, ctx);
    const trigger = compileTrigger(effective);
    ctx.replies.push({
      id: `b_${effective.id}`.slice(0, 64),
      name: effective.title,
      trigger,
      messages,
    });

    // Reply keyboards: buttons become hidden exact-text rules (the label is
    // what Telegram sends back). Non-text actions would be dead buttons.
    for (const [stepIdx, step] of effective.steps.entries()) {
      if (step.type !== 'message' || step.keyboard !== 'reply' || !step.buttons?.length) continue;
      for (const [btnIdx, button] of step.buttons.entries()) {
        const action = button.action;
        if (action.kind === 'link' || action.kind === 'webapp' || action.kind === 'copy') {
          ctx.issues.push(
            `Button "${button.label}" in "${effective.title}" opens a link/Mini App/copy — reply keyboards can only send text. ` +
              'Use an inline keyboard (the default) or make it a message/flow/AI button.',
          );
          continue;
        }
        const callback = callbackForAction(effective.id, stepIdx, btnIdx);
        ctx.replies.push({
          id: `k_${effective.id}_${stepIdx}_${btnIdx}`.slice(0, 64),
          name: button.label,
          trigger: { type: 'text', value: button.label },
          messages:
            action.kind === 'flow'
              ? [{ text: button.label, buttons: [[{ text: button.label, callback: callbackForBehavior(action.behaviorId) }]] }]
              : action.kind === 'ai'
                ? [{ text: button.label, ai: action.instruction ?? '' }]
                : [{ text: action.text }],
        });
      }
    }

    // Menu discoverability: command behaviors appear in Telegram's / menu.
    if (effective.when.type === 'command') {
      const command = effective.when.command.toLowerCase();
      const onlyAi = effective.steps.every((s) => s.type === 'ai');
      const aiInstruction = effective.steps.find((s) => s.type === 'ai')?.type === 'ai'
        ? (effective.steps.find((s) => s.type === 'ai') as { instruction?: string }).instruction
        : undefined;
      ctx.commands.push({
        command,
        description: effective.title.slice(0, 64),
        kind: onlyAi ? 'ai' : 'static',
        // static + empty response defers to the reply rule (pipeline order);
        // ai commands carry the guidance for the model.
        response: onlyAi ? (aiInstruction ?? '') : '',
      });
    }
  }
  if (ctx.issues.length) throw new BehaviorCompileError(ctx.issues);

  // Compiled-artifact limits (mirror botCommandsSchema/botRepliesSchema).
  const hiddenRules = ctx.replies.filter((r) => r.id.startsWith('a_') || r.id.startsWith('k_')).length;
  const menuCommands = list.filter((b) => b.when.type === 'command' && !(b.when.type === 'command' && b.when.command.toLowerCase() === '/start')).length;
  if (list.length + hiddenRules > 30) {
    ctx.issues.push(
      `This compiles to ${list.length + hiddenRules} rules — the limit is 30. Merge steps or remove buttons.`,
    );
  }
  if (menuCommands > 20) {
    ctx.issues.push(`Too many command behaviors (${menuCommands}) — Telegram allows 20 menu commands.`);
  }
  if (ctx.issues.length) throw new BehaviorCompileError(ctx.issues);

  // Stars compliance: selling digital goods auto-answers /terms /paysupport.
  const commands = ctx.hasPayment ? [...ctx.commands, ...complianceCommands(ctx.commands)] : ctx.commands;

  const caps = serializeCapabilities({ commands, replies: ctx.replies });
  const validated = {
    commands: botCommandsSchema.parse(caps.commandsJson ? JSON.parse(caps.commandsJson) : []),
    replies: botRepliesSchema.parse(caps.repliesJson ? JSON.parse(caps.repliesJson) : []),
  };
  return validated;
}

// ---------------------------------------------------------------------------
// Import — technical config → behaviors (for bots built the old way)
// ---------------------------------------------------------------------------

/**
 * Best-effort reverse mapping of existing commands/replies into behaviors so
 * pre-behavior bots can join the intent-first world. The compiler accepts the
 * result (round-trip: derive → compile preserves runtime behavior).
 */
export function deriveBehaviors(caps: BotCapabilities): BotBehaviorSpec[] {
  const behaviors: BotBehaviorSpec[] = [];

  const slug = (base: string, fallback: string) => {
    const s = base.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    return s || fallback;
  };
  const uniqueId = (base: string, fallback: string) => {
    let id = slug(base, fallback);
    let n = 2;
    while (behaviors.some((b) => b.id === id)) id = `${slug(base, fallback).slice(0, 36)}_${n++}`;
    return id;
  };

  // Steps of a reply → behavior steps. Button slots start empty and are
  // filled in pass 3, once every button-trigger rule has a behavior id.
  const stepsFromReply = (r: BotReplySpec): BehaviorStep[] =>
    r.messages.map((m) => {
      if (m.ai !== undefined) return { type: 'ai', instruction: m.ai } as BehaviorStep;
      if (m.media) return { type: 'media', media: m.media } as BehaviorStep;
      if (m.poll) {
        return {
          type: 'poll',
          poll: {
            question: m.poll.question,
            options: [...m.poll.options],
            ...(m.poll.quiz !== undefined ? { quiz: m.poll.quiz } : {}),
            ...(typeof m.poll.correctOption === 'number' ? { correctOption: m.poll.correctOption } : {}),
            ...(m.poll.explanation ? { explanation: m.poll.explanation } : {}),
            ...(m.poll.anonymous !== undefined ? { anonymous: m.poll.anonymous } : {}),
          },
        } as BehaviorStep;
      }
      if (m.payment) {
        return {
          type: 'payment',
          payment: {
            title: m.payment.title,
            description: m.payment.description,
            priceStars: m.payment.priceStars,
            ...(m.payment.successText ? { successText: m.payment.successText } : {}),
          },
        } as BehaviorStep;
      }
      if (m.collect) {
        return {
          type: 'collect',
          collect: { attribute: m.collect.attribute, ...(m.collect.prompt ? { prompt: m.collect.prompt } : {}) },
        } as BehaviorStep;
      }
      if (m.schedule) {
        return { type: 'schedule', schedule: { ...(m.schedule.prompt ? { prompt: m.schedule.prompt } : {}) } } as BehaviorStep;
      }
      if (m.remember) {
        return {
          type: 'remember',
          remember: { attribute: m.remember.attribute, value: m.remember.value, mode: m.remember.mode },
        } as BehaviorStep;
      }
      if (m.draw) {
        return {
          type: 'draw',
          draw: { attribute: m.draw.attribute, announce: m.draw.announce, emptyText: m.draw.emptyText },
        } as BehaviorStep;
      }
      if (m.top) {
        return {
          type: 'top',
          top: { attribute: m.top.attribute, title: m.top.title, limit: m.top.limit },
        } as BehaviorStep;
      }
      return {
        type: 'message',
        text: m.text,
        ...(m.buttons?.length ? { buttons: [] as BehaviorButton[] } : {}),
        ...(m.keyboard ? { keyboard: m.keyboard } : {}),
        ...(m.edit ? { edit: true } : {}),
        ...(m.forceReply ? { forceReply: true } : {}),
        ...(m.removeKeyboard ? { removeKeyboard: true } : {}),
      } as BehaviorStep;
    });

  // Pass 1: every non-button reply becomes a behavior. We track which
  // behavior came from which reply (indices diverge — buttons are skipped).
  const behaviorIndexBySourceReply = new Map<number, number>(); // replies[] idx → behaviors[] idx
  for (const [ri, r] of caps.replies.entries()) {
    if (r.trigger.type === 'button') continue;
    const when: BehaviorWhen =
      r.trigger.type === 'fallback'
        ? { type: 'anything_else' }
        : r.trigger.type === 'member_joined'
          ? { type: 'member_joined' }
          : r.trigger.type === 'payload'
            ? { type: 'payload', value: r.trigger.value ?? 'start' }
            : r.trigger.type === 'command'
              ? r.trigger.value?.toLowerCase() === '/start'
                ? { type: 'start' }
                : { type: 'command', command: r.trigger.value ?? '/help' }
              : { type: 'says', text: r.trigger.value ?? r.name };
    behaviors.push({
      id: uniqueId(r.id.replace(/^b_/, ''), r.name || 'flow'),
      title: r.name,
      when,
      steps: stepsFromReply(r),
    });
    behaviorIndexBySourceReply.set(ri, behaviors.length - 1);
  }

  // Pass 2: every button-trigger rule becomes the behavior behind a button,
  // and we remember callback → behaviorId so pass 3 can flow into it.
  const callbackToBehavior = new Map<string, string>();
  for (const r of caps.replies) {
    if (r.trigger.type !== 'button' || r.trigger.value === undefined) continue;
    const id = r.id.startsWith('b_') ? r.id.slice(2) : uniqueId(r.name || 'button', 'button');
    if (!behaviors.some((b) => b.id === id)) {
      behaviors.push({
        id,
        title: r.name,
        when: { type: 'button' },
        steps: stepsFromReply(r),
      });
    }
    callbackToBehavior.set(r.trigger.value, id);
  }

  // Pass 3: fill the reserved button slots with real plain-language actions.
  for (const [ri, r] of caps.replies.entries()) {
    const behavior = behaviors[behaviorIndexBySourceReply.get(ri) ?? -1];
    if (!behavior) continue;
    behavior.steps = r.messages.map((m, mi) => {
      if (m.ai !== undefined) return { type: 'ai', instruction: m.ai } as BehaviorStep;
      if (m.media || m.poll || m.payment || m.collect || m.schedule || m.remember || m.draw || m.top) return behavior.steps[mi];
      const flat = m.buttons?.flat() ?? [];
      const buttons: BehaviorButton[] = flat.map((b) => {
        if (b.webapp) return { label: b.text, action: { kind: 'webapp', url: b.webapp } as BehaviorButtonAction };
        if (b.copy) return { label: b.text, action: { kind: 'copy', text: b.copy } as BehaviorButtonAction };
        if (b.url) return { label: b.text, action: { kind: 'link', url: b.url } as BehaviorButtonAction };
        const targetId = b.callback ? callbackToBehavior.get(b.callback) : undefined;
        if (targetId) return { label: b.text, action: { kind: 'flow', behaviorId: targetId } as BehaviorButtonAction };
        // Unresolvable callback → a message action quoting the button label;
        // the owner decides what it should do (never a silent dead end).
        return { label: b.text, action: { kind: 'message', text: b.text } as BehaviorButtonAction };
      });
      const buttonsOut = buttons.length ? buttons : undefined;
      const step = behavior.steps[mi];
      if (step && step.type === 'message') {
        return buttonsOut ? ({ ...step, buttons: buttonsOut } as BehaviorStep) : ({ ...step, buttons: undefined } as BehaviorStep);
      }
      return {
        type: 'message',
        text: m.text,
        ...(buttonsOut ? { buttons: buttonsOut } : {}),
      } as BehaviorStep;
    });
  }

  // Pass 4: menu commands that no reply covers become behaviors too.
  for (const c of caps.commands) {
    const key = c.command.toLowerCase();
    const covered = behaviors.some(
      (b) =>
        (b.when.type === 'command' && b.when.command.toLowerCase() === key) ||
        (key === '/start' && b.when.type === 'start'),
    );
    if (covered) continue;
    behaviors.push({
      id: uniqueId(key.replace(/^\//, ''), 'command'),
      title: c.description || c.command,
      when: key === '/start' ? { type: 'start' } : { type: 'command', command: key },
      steps:
        c.kind === 'ai' && c.response
          ? [{ type: 'ai', instruction: c.response }]
          : [{ type: 'message', text: c.response || `${c.description || c.command}.` }],
    });
  }

  return botBehaviorsSchema.parse(behaviors);
}

// ---------------------------------------------------------------------------
// Human summaries — used by the UI and the agent activity feed
// ---------------------------------------------------------------------------

/** "When someone starts the bot" — the trigger, in plain words. */
export function describeWhen(when: BehaviorWhen): string {
  switch (when.type) {
    case 'start':
      return 'When someone starts the bot';
    case 'command':
      return `When someone types ${when.command.toLowerCase()}`;
    case 'says':
      return `When a message mentions “${when.text}”`;
    case 'button':
      return 'When a button is pressed';
    case 'payload':
      return `When someone arrives from the “${when.value}” link`;
    case 'member_joined':
      return 'When someone joins the group';
    case 'anything_else':
      return 'For anything else';
  }
}

/** One-line summary of the steps: "Welcome! + 3 buttons → AI reply". */
export function describeSteps(steps: BehaviorStep[]): string {
  return steps
    .map((s) => {
      if (s.type === 'ai') return 'the AI answers';
      if (s.type === 'media') {
        const cap = s.media.caption ? `“${s.media.caption.slice(0, 32)}”` : `a ${s.media.kind}`;
        return `sends ${cap}`;
      }
      if (s.type === 'poll') return `poll: ${s.poll.question.slice(0, 32)}`;
      if (s.type === 'payment') return `charges ${s.payment.priceStars}★ for ${s.payment.title}`;
      if (s.type === 'collect') return `asks and remembers ${s.collect.attribute}`;
      if (s.type === 'schedule') return 'sets a reminder';
      if (s.type === 'remember') {
        return s.remember.mode === 'add'
          ? `adds ${s.remember.value || '1'} to ${s.remember.attribute}`
          : `remembers ${s.remember.attribute}`;
      }
      if (s.type === 'draw') return `draws a winner by ${s.draw.attribute}`;
      if (s.type === 'top') return `leaderboard: top ${s.top.limit} by ${s.top.attribute}`;
      const btns = s.buttons?.length ? ` + ${s.buttons.length} button${s.buttons.length === 1 ? '' : 's'}` : '';
      const excerpt = s.text.length > 42 ? `${s.text.slice(0, 42).trimEnd()}…` : s.text;
      return excerpt ? `“${excerpt}”${btns}` : btns || 'a screen';
    })
    .join(' → ');
}
