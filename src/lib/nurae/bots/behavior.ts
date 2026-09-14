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
 * keyboards, callback wiring, AI steps). Commands/callbacks/workflows stay
 * real underneath — they are simply not the language people build in.
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
 *   Show a message · Open a link · Start a flow · Ask the AI
 * (No "callback query", no "inline keyboard" — the compiler decides that.)
 */
export const behaviorButtonActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('message'), text: z.string().trim().min(1).max(4000) }),
  z.object({ kind: z.literal('link'), url: z.string().trim().url('Button URL must be valid').max(256) }),
  // Starts another behavior (by id). The compiler wires the callback.
  z.object({ kind: z.literal('flow'), behaviorId: z.string().trim().regex(idPattern) }),
  // Hands the turn to the bot's AI, optionally with extra guidance.
  z.object({ kind: z.literal('ai'), instruction: z.string().trim().max(2000).optional() }),
]);

export const behaviorButtonSchema = z.object({
  label: z.string().trim().min(1).max(64),
  action: behaviorButtonActionSchema,
});

export const behaviorStepSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message'),
    text: z.string().trim().min(1).max(4000),
    buttons: z.array(behaviorButtonSchema).max(8).optional(),
  }),
  z.object({
    type: z.literal('ai'),
    instruction: z.string().trim().max(2000).optional(),
  }),
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
}

function callbackForAction(behaviorId: string, stepIdx: number, btnIdx: number): string {
  // e.g. r:a_welcome_0_1 — deterministic so recompiles keep stable callbacks.
  return `${BTN_PREFIX}_${behaviorId}_${stepIdx}_${btnIdx}`;
}

function callbackForBehavior(behaviorId: string): string {
  return `${FLOW_PREFIX}_${behaviorId}`;
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
    const buttons = step.buttons?.length ? [step.buttons.map((b, btnIdx) => compileButton(b, behavior, stepIdx, btnIdx, ctx))] : undefined;
    return {
      text: step.text,
      ...(buttons ? { buttons } : {}),
    };
  });
}

function compileButton(
  button: BehaviorButton,
  behavior: BotBehaviorSpec,
  stepIdx: number,
  btnIdx: number,
  ctx: Ctx,
): { text: string; url?: string; callback?: string } {
  const action = button.action;
  switch (action.kind) {
    case 'link':
      return { text: button.label, url: action.url };
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
    case 'anything_else':
      return { type: 'fallback' };
  }
}

/**
 * Compile behaviors into executable capabilities.
 *
 * Guarantees:
 *  - every generated reply/button passes botReplySchema (the pipeline's loader
 *    re-validates, so a bad compile can never poison a running bot);
 *  - flow actions point at behaviors that exist;
 *  - command triggers are unique (/start normalizes to a start behavior);
 *  - menu commands exist for every command behavior so Telegram's / menu
 *    stays discoverable.
 */
export function compileBehaviors(behaviors: BotBehaviorSpec[]): BotCapabilities {
  const list = behaviors?.length ? botBehaviorsSchema.parse(behaviors) : [];
  const ctx: Ctx = { commands: [], replies: [], issues: [] };

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
    for (const [stepIdx, step] of b.steps.entries()) {
      if (step.type !== 'message' || !step.buttons) continue;
      for (const button of step.buttons) {
        if (button.action.kind === 'flow' && !ids.has(button.action.behaviorId)) {
          ctx.issues.push(
            `Button "${button.label}" in "${b.title}" starts flow "${button.action.behaviorId}", which does not exist.`,
          );
        }
        void stepIdx;
      }
    }
  }
  if (ctx.issues.length) throw new BehaviorCompileError(ctx.issues);

  // Compiled-artifact limits (mirror botCommandsSchema/botRepliesSchema).
  const hiddenRules = list.reduce(
    (n, b) =>
      n +
      b.steps.reduce(
        (m, s) => m + (s.type === 'message' && s.buttons ? s.buttons.filter((x) => x.action.kind !== 'link' && x.action.kind !== 'flow').length : 0),
        0,
      ),
    0,
  );
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

  const caps = serializeCapabilities({ commands: ctx.commands, replies: ctx.replies });
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
      return {
        type: 'message',
        text: m.text,
        ...(m.buttons?.length ? { buttons: [] as BehaviorButton[] } : {}),
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
      const flat = m.buttons?.flat() ?? [];
      const buttons: BehaviorButton[] = flat.map((b) => {
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
    case 'anything_else':
      return 'For anything else';
  }
}

/** One-line summary of the steps: "Welcome! + 3 buttons → AI reply". */
export function describeSteps(steps: BehaviorStep[]): string {
  return steps
    .map((s) => {
      if (s.type === 'ai') return 'the AI answers';
      const btns = s.buttons?.length ? ` + ${s.buttons.length} button${s.buttons.length === 1 ? '' : 's'}` : '';
      const excerpt = s.text.length > 42 ? `${s.text.slice(0, 42).trimEnd()}…` : s.text;
      return `“${excerpt}”${btns}`;
    })
    .join(' → ');
}
