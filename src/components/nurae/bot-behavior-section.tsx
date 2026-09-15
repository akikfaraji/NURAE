'use client';

/**
 * NURAE — the Behavior editor: the primary surface of bot building.
 *
 * People describe what the bot should do; NURAE wires commands, buttons,
 * callbacks and flows underneath. This component never shows the words
 * "callback", "inline keyboard" or "rule" — a button has a label and a
 * "what should it do" action; a behavior has a "when" and "then" steps.
 *
 * The whole list is saved via PATCH { behaviors } — the server compiles it
 * into the executed configuration (see src/lib/nurae/bots/behavior.ts).
 */

import { useState } from 'react';
import {
  BehaviorButtonActionDTO,
  BehaviorButtonDTO,
  BehaviorStepDTO,
  BehaviorWhenDTO,
  BotBehaviorDTO,
  UserBotDTO,
} from '@/lib/nurae-client/api';
import { deriveBehaviors } from '@/lib/nurae/bots/behavior';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

// ---------------------------------------------------------------------------
// Plain-language descriptions (mirror the server's describeWhen/describeSteps
// so the client bundle stays free of the compiler's zod schemas where easy)
// ---------------------------------------------------------------------------

export function whenLabel(when: BehaviorWhenDTO): string {
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

function actionLabel(action: BehaviorButtonActionDTO, all: BotBehaviorDTO[]): string {
  switch (action.kind) {
    case 'message':
      return 'shows a message';
    case 'link':
      return 'opens a link';
    case 'webapp':
      return 'opens a Mini App';
    case 'copy':
      return 'copies text';
    case 'flow': {
      const target = all.find((b) => b.id === action.behaviorId);
      return target ? `starts “${target.title}”` : 'starts a flow';
    }
    case 'ai':
      return 'asks the AI';
  }
}

function stepsSummary(steps: BehaviorStepDTO[], all: BotBehaviorDTO[]): string {
  return steps
    .map((s) => {
      if (s.type === 'ai') return 'the AI answers';
      if (s.type === 'media') {
        return s.media.caption ? `sends a ${s.media.kind} “${s.media.caption.slice(0, 32)}”` : `sends a ${s.media.kind}`;
      }
      if (s.type === 'poll') return `poll: ${s.poll.question.slice(0, 36)}`;
      if (s.type === 'payment') return `charges ${s.payment.priceStars}★ for ${s.payment.title}`;
      if (s.type === 'collect') return `asks and remembers ${s.collect.attribute}`;
      if (s.type === 'schedule') return 'sets a reminder';
      if (s.type === 'remember') {
        return s.remember.mode === 'add' ? `adds to ${s.remember.attribute}` : `remembers ${s.remember.attribute}`;
      }
      if (s.type === 'draw') return `draws a winner by ${s.draw.attribute}`;
      if (s.type === 'top') return `leaderboard by ${s.top.attribute}`;
      if (s.type === 'verify_join') return `join gate on ${s.verifyJoin.chat}`;
      if (s.type === 'streak') return `daily streak on ${s.streak.attribute}`;
      if (s.type === 'milestone') return `milestone ${s.milestone.attribute}=${s.milestone.value}`;
      if (s.type === 'email_invite') return `emails an invite to {{${s.emailInvite.attribute}}}`;
      if (s.type === 'email_unsubscribe') return 'unsubscribes this chat';
      const btns = s.buttons?.length ? ` + ${s.buttons.length} button${s.buttons.length === 1 ? '' : 's'}` : '';
      const excerpt = s.text.length > 48 ? `${s.text.slice(0, 48).trimEnd()}…` : s.text;
      return excerpt ? `“${excerpt}”${btns}` : btns || 'a screen';
    })
    .join(' → ')
    + buttonFlowNotes(steps, all);
}

function buttonFlowNotes(steps: BehaviorStepDTO[], all: BotBehaviorDTO[]): string {
  const notes: string[] = [];
  for (const s of steps) {
    if (s.type !== 'message' || !s.buttons) continue;
    for (const b of s.buttons) {
      if (b.action.kind === 'flow') notes.push(`${b.label} → ${actionLabel(b.action, all)}`);
      else if (b.action.kind === 'ai') notes.push(`${b.label} → asks the AI`);
      else if (b.action.kind === 'link') notes.push(`${b.label} → opens a link`);
    }
  }
  return notes.length ? `  (${notes.join(', ')})` : '';
}

const slugify = (t: string) =>
  t.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'flow';

// ---------------------------------------------------------------------------
// The section
// ---------------------------------------------------------------------------

export function BehaviorSection({
  bot,
  saving,
  onSave,
}: {
  bot: UserBotDTO;
  saving: boolean;
  onSave: (patch: Record<string, unknown>) => void;
}) {
  const [behaviors, setBehaviors] = useState<BotBehaviorDTO[]>(bot.behaviors);
  const [editing, setEditing] = useState<BotBehaviorDTO | null>(null); // working copy
  const [isNew, setIsNew] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  // Render-phase resync when the bot record changes.
  const [prevVersion, setPrevVersion] = useState(`${bot.id}:${bot.updatedAt}`);
  if (prevVersion !== `${bot.id}:${bot.updatedAt}`) {
    setPrevVersion(`${bot.id}:${bot.updatedAt}`);
    setBehaviors(bot.behaviors);
    setEditing(null);
    setIsNew(false);
  }

  const importLegacy = () => {
    const derived = deriveBehaviors({ commands: bot.commands, replies: bot.replies });
    if (!derived.length) {
      setLocalError('Nothing to import yet — this bot has no commands or replies.');
      return;
    }
    onSave({ behaviors: derived });
  };

  const remove = (id: string) => {
    const next = behaviors.filter((b) => b.id !== id);
    setBehaviors(next);
    onSave({ behaviors: next });
  };

  const saveEditing = (next: BotBehaviorDTO) => {
    const list = isNew ? [...behaviors, next] : behaviors.map((b) => (b.id === editing?.id ? next : b));
    setBehaviors(list);
    setEditing(null);
    setIsNew(false);
    onSave({ behaviors: list });
  };

  const startNew = () => {
    setIsNew(true);
    setLocalError(null);
    setEditing({
      id: slugify('New behavior'),
      title: 'New behavior',
      when: { type: 'says', text: '' },
      steps: [{ type: 'message', text: '' }],
    });
  };

  return (
    <section className="mt-10 border-t border-border/60 pt-6">
      <h2 className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Behavior</h2>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground/80">
        What this bot does, in plain language. Buttons, commands and flows are wired automatically —
        the technical details stay out of the way.
      </p>

      {behaviors.length === 0 && (
        <div className="mt-4 max-w-xl text-sm leading-relaxed text-muted-foreground">
          <p>
            Nothing described yet. Add a behavior — for example
            <span className="text-foreground"> “when someone starts the bot, welcome them with buttons for Menu, Order and Contact”</span> —
            or let the Bot Builder agent do it from the chat.
          </p>
          {(bot.commands.length > 0 || bot.replies.length > 0) && (
            <button
              type="button"
              onClick={importLegacy}
              disabled={saving}
              className="mt-3 text-xs text-foreground underline underline-offset-4 hover:no-underline disabled:opacity-50"
            >
              Import the existing configuration as behaviors
            </button>
          )}
        </div>
      )}

      <ul className="mt-5 divide-y divide-border/60 border-y border-border/60">
        {behaviors.map((b) => {
          const isEditing = editing !== null && !isNew && editing.id === b.id;
          if (isEditing && editing) {
            return (
              <li key={b.id} className="py-5">
                <BehaviorEditor
                  value={editing}
                  allBehaviors={behaviors}
                  saving={saving}
                  onCancel={() => {
                    setEditing(null);
                    setIsNew(false);
                  }}
                  onSave={saveEditing}
                />
              </li>
            );
          }
          return (
            <li key={b.id} className="group py-4">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-sm text-foreground">{whenLabel(b.when)}</span>
                <span className="text-xs text-muted-foreground">→ {b.title}</span>
                <span className="ml-auto flex gap-3 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
                  <button
                    type="button"
                    className="text-[11px] text-muted-foreground hover:text-foreground"
                    onClick={() => {
                      setIsNew(false);
                      setLocalError(null);
                      setEditing(structuredClone(b));
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="text-[11px] text-muted-foreground hover:text-destructive"
                    onClick={() => remove(b.id)}
                  >
                    Remove
                  </button>
                </span>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground/80">
                {stepsSummary(b.steps, behaviors)}
              </p>
            </li>
          );
        })}
        {editing !== null && isNew && (
          <li className="py-5">
            <BehaviorEditor
              value={editing}
              allBehaviors={behaviors}
              saving={saving}
              onCancel={() => {
                setEditing(null);
                setIsNew(false);
              }}
              onSave={saveEditing}
            />
          </li>
        )}
      </ul>

      {localError && <p className="mt-2 text-xs text-destructive" role="alert">{localError}</p>}

      {editing === null && (
        <div className="mt-4">
          <Button size="sm" variant="ghost" onClick={startNew} disabled={saving}>
            + Add behavior
          </Button>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The editor — one behavior, plain language
// ---------------------------------------------------------------------------

const WHEN_OPTIONS: Array<{ value: BehaviorWhenDTO['type']; label: string }> = [
  { value: 'start', label: 'someone starts the bot' },
  { value: 'command', label: 'someone types a command' },
  { value: 'says', label: 'a message mentions…' },
  { value: 'button', label: 'a button is pressed' },
  { value: 'payload', label: 'someone arrives from a link…' },
  { value: 'member_joined', label: 'someone joins the group' },
  { value: 'anything_else', label: 'anything else' },
];

const ACTION_OPTIONS: Array<{ value: BehaviorButtonActionDTO['kind']; label: string }> = [
  { value: 'message', label: 'Show a message' },
  { value: 'link', label: 'Open a link' },
  { value: 'webapp', label: 'Open a Mini App' },
  { value: 'copy', label: 'Copy text' },
  { value: 'flow', label: 'Start a flow' },
  { value: 'ai', label: 'Ask the AI' },
];

function BehaviorEditor({
  value,
  allBehaviors,
  saving,
  onCancel,
  onSave,
}: {
  value: BotBehaviorDTO;
  allBehaviors: BotBehaviorDTO[];
  saving: boolean;
  onCancel: () => void;
  onSave: (next: BotBehaviorDTO) => void;
}) {
  const [draft, setDraft] = useState<BotBehaviorDTO>(value);
  const [error, setError] = useState<string | null>(null);

  const patchStep = (i: number, patch: Partial<Extract<BehaviorStepDTO, { type: 'message' }>>) =>
    setDraft((d) => ({
      ...d,
      steps: d.steps.map((s, idx) => (idx === i && s.type === 'message' ? { ...s, ...patch } : s)),
    }));

  const patchButton = (si: number, bi: number, patch: Partial<BehaviorButtonDTO>) =>
    setDraft((d) => ({
      ...d,
      steps: d.steps.map((s, idx) =>
        idx === si && s.type === 'message' && s.buttons
          ? { ...s, buttons: s.buttons.map((b, bidx) => (bidx === bi ? { ...b, ...patch } : b)) }
          : s,
      ),
    }));

  const submit = () => {
    const title = draft.title.trim();
    if (!title) {
      setError('Give this behavior a short name.');
      return;
    }
    if (draft.when.type === 'says' && !draft.when.text.trim()) {
      setError('Write the word or phrase to react to.');
      return;
    }
    if (draft.when.type === 'command' && !/^\/[a-zA-Z0-9_]{1,32}$/.test(draft.when.command.trim())) {
      setError('Commands look like /menu (letters, digits, underscore).');
      return;
    }
    for (const [si, s] of draft.steps.entries()) {
      if (s.type === 'message') {
        if (!s.text.trim()) {
          setError(`Step ${si + 1}: write the message text.`);
          return;
        }
        for (const b of s.buttons ?? []) {
          if (!b.label.trim()) {
            setError(`Step ${si + 1}: a button needs a label.`);
            return;
          }
          if (b.action.kind === 'message' && !b.action.text.trim()) {
            setError(`Button “${b.label}”: write the message it shows.`);
            return;
          }
          if (b.action.kind === 'flow' && !b.action.behaviorId) {
            setError(`Button “${b.label}”: pick which flow it starts.`);
            return;
          }
          if ((b.action.kind === 'link' || b.action.kind === 'webapp') && !b.action.url.trim()) {
            setError(`Button “${b.label}”: add the URL.`);
            return;
          }
          if (b.action.kind === 'copy' && !b.action.text.trim()) {
            setError(`Button “${b.label}”: write the text it copies.`);
            return;
          }
        }
      }
      if (s.type === 'media' && !s.media.source.trim()) {
        setError(`Step ${si + 1}: add the ${s.media.kind} URL (or a Telegram file_id).`);
        return;
      }
      if (s.type === 'collect' && !/^[a-zA-Z0-9_-]{1,40}$/.test(s.collect.attribute.trim())) {
        setError(`Step ${si + 1}: attribute names are short slugs — letters, digits, "-", "_".`);
        return;
      }
      if (s.type === 'remember' && !/^[a-zA-Z0-9_-]{1,40}$/.test(s.remember.attribute.trim())) {
        setError(`Step ${si + 1}: attribute names are short slugs — letters, digits, "-", "_".`);
        return;
      }
      if (s.type === 'draw' && !/^[a-zA-Z0-9_-]{1,40}$/.test(s.draw.attribute.trim())) {
        setError(`Step ${si + 1}: attribute names are short slugs — letters, digits, "-", "_".`);
        return;
      }
      if (s.type === 'top' && !/^[a-zA-Z0-9_-]{1,40}$/.test(s.top.attribute.trim())) {
        setError(`Step ${si + 1}: attribute names are short slugs — letters, digits, "-", "_".`);
        return;
      }
      if (s.type === 'poll') {
        const options = s.poll.options.map((o) => o.trim()).filter(Boolean);
        if (!s.poll.question.trim() || options.length < 2) {
          setError(`Step ${si + 1}: a poll needs a question and at least two options.`);
          return;
        }
      }
      if (s.type === 'payment' && (!s.payment.title.trim() || !s.payment.description.trim())) {
        setError(`Step ${si + 1}: a payment needs a product name and what the buyer gets.`);
        return;
      }
    }
    // Unique "when" sanity: two behaviors on the same trigger confuse everyone.
    const key = JSON.stringify(draft.when);
    const clash = allBehaviors.some((b) => b.id !== draft.id && JSON.stringify(b.when) === key);
    if (clash) {
      setError('Another behavior already reacts to exactly this. Edit that one instead.');
      return;
    }
    const id = draft.id.trim() || slugify(title);
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(id)) {
      setError('Internal id: use letters, digits, "-" or "_" (max 40).');
      return;
    }
    setError(null);
    onSave({ ...draft, id, title, when: { ...draft.when } });
  };

  const otherBehaviors = allBehaviors.filter((b) => b.id !== draft.id);

  return (
    <div className="space-y-5">
      {/* WHEN */}
      <div className="grid gap-3 sm:grid-cols-[220px_1fr] sm:items-start">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">When…</Label>
          <select
            value={draft.when.type}
            onChange={(e) => {
              const type = e.target.value as BehaviorWhenDTO['type'];
              setDraft((d) => ({
                ...d,
                when:
                  type === 'start'
                    ? { type: 'start' }
                    : type === 'command'
                      ? { type: 'command', command: d.when.type === 'command' ? d.when.command : '/' }
                      : type === 'says'
                        ? { type: 'says', text: d.when.type === 'says' ? d.when.text : '' }
                        : type === 'payload'
                          ? { type: 'payload', value: d.when.type === 'payload' ? d.when.value : '' }
                          : type === 'button'
                            ? { type: 'button' }
                            : type === 'member_joined'
                              ? { type: 'member_joined' }
                              : { type: 'anything_else' },
              }));
            }}
            className="h-9 w-full rounded-md border border-border bg-transparent px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
          >
            {WHEN_OPTIONS.map((o) => (
              <option key={o.value} value={o.value} className="bg-background">{o.label}</option>
            ))}
          </select>
        </div>
        {draft.when.type === 'command' && (
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Command</Label>
            <Input
              value={draft.when.command}
              onChange={(e) => setDraft((d) => ({ ...d, when: { type: 'command', command: e.target.value } }))}
              placeholder="/menu"
              maxLength={33}
              className="bg-transparent font-mono text-xs"
            />
          </div>
        )}
        {draft.when.type === 'says' && (
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Word or phrase</Label>
            <Input
              value={draft.when.text}
              onChange={(e) => setDraft((d) => ({ ...d, when: { type: 'says', text: e.target.value } }))}
              placeholder="price"
              maxLength={64}
              className="bg-transparent text-sm"
            />
          </div>
        )}
        {draft.when.type === 'payload' && (
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Link payload</Label>
            <Input
              value={draft.when.value}
              onChange={(e) => setDraft((d) => ({ ...d, when: { type: 'payload', value: e.target.value } }))}
              placeholder="flyer — matches t.me/yourbot?start=flyer…"
              maxLength={64}
              className="bg-transparent font-mono text-xs"
            />
            <p className="text-[11px] text-muted-foreground">Deep links look like t.me/yourbot?start=flyer — any payload starting with this word triggers the behavior.</p>
          </div>
        )}
        {draft.when.type === 'member_joined' && (
          <p className="self-end text-xs text-muted-foreground">
            Runs in groups when a new member joins — a welcome with the rules, for example. Add the bot to the group as admin so joins are visible.
          </p>
        )}
        {draft.when.type === 'button' && (
          <p className="self-end text-xs text-muted-foreground">
            This runs when a button whose action is “Start a flow” points here.
          </p>
        )}
      </div>

      {/* THEN */}
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">…then what happens</Label>
        <div className="space-y-4">
          {draft.steps.map((step, si) => (
            <div key={si} className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] uppercase tracking-widest text-muted-foreground/70">
                  {step.type === 'message'
                    ? `Message ${si + 1}`
                    : step.type === 'ai'
                      ? 'AI answer'
                      : step.type === 'media'
                        ? 'Photo / file'
                        : step.type === 'poll'
                          ? 'Poll'
                          : step.type === 'payment'
                            ? 'Stars payment'
                            : step.type === 'collect'
                              ? 'Ask and remember'
                              : step.type === 'remember'
                                ? 'Remember (silent)'
                                : step.type === 'draw'
                                  ? 'Draw a winner'
                                  : step.type === 'top'
                                    ? 'Leaderboard'
                                    : step.type === 'verify_join'
                                      ? 'Join gate (channel check)'
                                      : step.type === 'streak'
                                        ? 'Daily streak (silent)'
                                        : step.type === 'milestone'
                                          ? 'Milestone (celebrate once)'
                                          : step.type === 'email_invite'
                                            ? 'Email invite (SMTP)'
                                            : step.type === 'email_unsubscribe'
                                              ? 'Email unsubscribe'
                                              : 'Set a reminder'}
                </span>
                <button
                  type="button"
                  className="text-[11px] text-muted-foreground hover:text-destructive"
                  onClick={() => setDraft((d) => ({ ...d, steps: d.steps.filter((_, idx) => idx !== si) }))}
                >
                  Remove step
                </button>
              </div>

              {step.type === 'ai' ? (
                <Textarea
                  value={step.instruction ?? ''}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      steps: d.steps.map((s, idx) =>
                        idx === si ? ({ type: 'ai', instruction: e.target.value } as BehaviorStepDTO) : s,
                      ),
                    }))
                  }
                  placeholder="Optional guidance for the AI (e.g. “answer questions about our menu”)."
                  rows={2}
                  maxLength={2000}
                  className="bg-transparent text-sm"
                />
              ) : step.type === 'media' ? (
                <div className="grid gap-2 sm:grid-cols-[minmax(0,140px)_1fr]">
                  <select
                    value={step.media.kind}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        steps: d.steps.map((s, idx) =>
                          idx === si && s.type === 'media'
                            ? { ...s, media: { ...s.media, kind: e.target.value } }
                            : s,
                        ),
                      }))
                    }
                    className="h-9 w-full rounded-md border border-border bg-transparent px-2 text-xs text-foreground outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
                  >
                    {['photo', 'video', 'audio', 'voice', 'animation', 'document', 'sticker'].map((k) => (
                      <option key={k} value={k} className="bg-background">{k}</option>
                    ))}
                  </select>
                  <Input
                    value={step.media.source}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        steps: d.steps.map((s, idx) =>
                          idx === si && s.type === 'media' ? { ...s, media: { ...s.media, source: e.target.value } } : s,
                        ),
                      }))
                    }
                    placeholder="https://… (or a Telegram file_id)"
                    maxLength={512}
                    className="bg-transparent font-mono text-xs"
                  />
                  <Input
                    value={step.media.caption ?? ''}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        steps: d.steps.map((s, idx) =>
                          idx === si && s.type === 'media' ? { ...s, media: { ...s.media, caption: e.target.value } } : s,
                        ),
                      }))
                    }
                    placeholder="Caption (markdown works, {{name}} too)"
                    maxLength={1024}
                    className="bg-transparent text-sm sm:col-span-2"
                  />
                </div>
              ) : step.type === 'collect' ? (
                <div className="space-y-2">
                  <div className="grid gap-2 sm:grid-cols-[minmax(0,220px)_1fr]">
                    <Input
                      value={step.collect.attribute}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          steps: d.steps.map((s, idx) =>
                            idx === si && s.type === 'collect' ? { ...s, collect: { ...s.collect, attribute: e.target.value } } : s,
                          ),
                        }))
                      }
                      placeholder="name_of_thing"
                      maxLength={40}
                      className="bg-transparent font-mono text-xs"
                    />
                    <Input
                      value={step.collect.prompt ?? ''}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          steps: d.steps.map((s, idx) =>
                            idx === si && s.type === 'collect' ? { ...s, collect: { ...s.collect, prompt: e.target.value } } : s,
                          ),
                        }))
                      }
                      placeholder="What should the bot ask?"
                      maxLength={1000}
                      className="bg-transparent text-sm"
                    />
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    The answer is remembered per user — reuse it anywhere as <code className="font-mono">{'{{name_of_thing}}'}</code>.
                  </p>
                </div>
              ) : step.type === 'schedule' ? (
                <Input
                  value={step.schedule.prompt ?? ''}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      steps: d.steps.map((s, idx) =>
                        idx === si && s.type === 'schedule' ? { ...s, schedule: { prompt: e.target.value } } : s,
                      ),
                    }))
                  }
                  placeholder="What should the bot ask? (e.g. “What and when should I remind you?”)"
                  maxLength={1000}
                  className="bg-transparent text-sm"
                />
              ) : step.type === 'poll' ? (
                <div className="space-y-2">
                  <Input
                    value={step.poll.question}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        steps: d.steps.map((s, idx) =>
                          idx === si && s.type === 'poll' ? { ...s, poll: { ...s.poll, question: e.target.value } } : s,
                        ),
                      }))
                    }
                    placeholder="The question"
                    maxLength={300}
                    className="bg-transparent text-sm"
                  />
                  <Textarea
                    value={step.poll.options.join('\n')}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        steps: d.steps.map((s, idx) =>
                          idx === si && s.type === 'poll'
                            ? { ...s, poll: { ...s.poll, options: e.target.value.split('\n').slice(0, 12) } }
                            : s,
                        ),
                      }))
                    }
                    placeholder={'One option per line (2–12)'}
                    rows={3}
                    className="bg-transparent text-sm"
                  />
                </div>
              ) : step.type === 'payment' ? (
                <div className="space-y-2">
                  <div className="grid gap-2 sm:grid-cols-[minmax(0,180px)_minmax(0,110px)_1fr]">
                    <Input
                      value={step.payment.title}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          steps: d.steps.map((s, idx) =>
                            idx === si && s.type === 'payment' ? { ...s, payment: { ...s.payment, title: e.target.value } } : s,
                          ),
                        }))
                      }
                      placeholder="Product name"
                      maxLength={32}
                      className="bg-transparent text-sm"
                    />
                    <Input
                      type="number"
                      min={1}
                      max={25000}
                      value={step.payment.priceStars || ''}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          steps: d.steps.map((s, idx) =>
                            idx === si && s.type === 'payment'
                              ? { ...s, payment: { ...s.payment, priceStars: Math.max(1, Math.round(Number(e.target.value) || 1)) } }
                              : s,
                          ),
                        }))
                      }
                      placeholder="★"
                      className="bg-transparent text-sm"
                    />
                    <Input
                      value={step.payment.description}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          steps: d.steps.map((s, idx) =>
                            idx === si && s.type === 'payment' ? { ...s, payment: { ...s.payment, description: e.target.value } } : s,
                          ),
                        }))
                      }
                      placeholder="What the buyer gets"
                      maxLength={255}
                      className="bg-transparent text-sm"
                    />
                  </div>
                  <Input
                    value={step.payment.successText ?? ''}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        steps: d.steps.map((s, idx) =>
                          idx === si && s.type === 'payment' ? { ...s, payment: { ...s.payment, successText: e.target.value } } : s,
                        ),
                      }))
                    }
                    placeholder="Sent right after payment — deliver the goods here (link, code, …)"
                    maxLength={4000}
                    className="bg-transparent text-sm"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Digital goods are charged in Telegram Stars; /terms, /paysupport and /support are answered automatically.
                  </p>
                </div>
              ) : step.type === 'remember' ? (
                <div className="space-y-2">
                  <div className="grid gap-2 sm:grid-cols-[minmax(0,200px)_150px_minmax(0,200px)]">
                    <Input
                      value={step.remember.attribute}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          steps: d.steps.map((s, idx) =>
                            idx === si && s.type === 'remember' ? { ...s, remember: { ...s.remember, attribute: e.target.value } } : s,
                          ),
                        }))
                      }
                      placeholder="invites"
                      maxLength={40}
                      className="bg-transparent font-mono text-xs"
                    />
                    <select
                      value={step.remember.mode ?? 'set'}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          steps: d.steps.map((s, idx) =>
                            idx === si && s.type === 'remember'
                              ? { ...s, remember: { ...s.remember, mode: e.target.value as 'set' | 'add' } }
                              : s,
                          ),
                        }))
                      }
                      className="h-9 w-full rounded-md border border-border bg-transparent px-2 text-xs text-foreground outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
                    >
                      <option value="set" className="bg-background">set to</option>
                      <option value="add" className="bg-background">add</option>
                    </select>
                    <Input
                      value={step.remember.value ?? ''}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          steps: d.steps.map((s, idx) =>
                            idx === si && s.type === 'remember' ? { ...s, remember: { ...s.remember, value: e.target.value } } : s,
                          ),
                        }))
                      }
                      placeholder={step.remember.mode === 'add' ? '1 (the amount to add)' : 'yes'}
                      maxLength={2000}
                      className="bg-transparent font-mono text-xs"
                    />
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Silent — sends nothing. Reuse anywhere as <code className="font-mono">{'{{invites}}'}</code>; “add” increments numbers (counters, scores, entries).
                  </p>
                </div>
              ) : step.type === 'draw' ? (
                <div className="space-y-2">
                  <div className="grid gap-2 sm:grid-cols-[minmax(0,200px)_1fr]">
                    <Input
                      value={step.draw.attribute}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          steps: d.steps.map((s, idx) =>
                            idx === si && s.type === 'draw' ? { ...s, draw: { ...s.draw, attribute: e.target.value } } : s,
                          ),
                        }))
                      }
                      placeholder="entered"
                      maxLength={40}
                      className="bg-transparent font-mono text-xs"
                    />
                    <Input
                      value={step.draw.announce ?? ''}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          steps: d.steps.map((s, idx) =>
                            idx === si && s.type === 'draw' ? { ...s, draw: { ...s.draw, announce: e.target.value } } : s,
                          ),
                        }))
                      }
                      placeholder="🎉 The winner is {{winner_name}} ({{winner_chat}}) — {{count}} entrant(s)!"
                      maxLength={4000}
                      className="bg-transparent text-sm"
                    />
                  </div>
                  <Input
                    value={step.draw.emptyText ?? ''}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        steps: d.steps.map((s, idx) =>
                          idx === si && s.type === 'draw' ? { ...s, draw: { ...s.draw, emptyText: e.target.value } } : s,
                        ),
                      }))
                    }
                    placeholder="No entrants yet — nobody to draw from."
                    maxLength={1000}
                    className="bg-transparent text-xs"
                  />
                  <p className="text-[11px] text-muted-foreground">Draws one random user among everyone holding that attribute.</p>
                </div>
              ) : step.type === 'top' ? (
                <div className="space-y-2">
                  <div className="grid gap-2 sm:grid-cols-[minmax(0,200px)_1fr_minmax(0,110px)]">
                    <Input
                      value={step.top.attribute}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          steps: d.steps.map((s, idx) =>
                            idx === si && s.type === 'top' ? { ...s, top: { ...s.top, attribute: e.target.value } } : s,
                          ),
                        }))
                      }
                      placeholder="score"
                      maxLength={40}
                      className="bg-transparent font-mono text-xs"
                    />
                    <Input
                      value={step.top.title ?? ''}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          steps: d.steps.map((s, idx) =>
                            idx === si && s.type === 'top' ? { ...s, top: { ...s.top, title: e.target.value } } : s,
                          ),
                        }))
                      }
                      placeholder="Leaderboard"
                      maxLength={200}
                      className="bg-transparent text-sm"
                    />
                    <Input
                      type="number"
                      min={1}
                      max={20}
                      value={step.top.limit ?? ''}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          steps: d.steps.map((s, idx) =>
                            idx === si && s.type === 'top'
                              ? { ...s, top: { ...s.top, limit: Math.min(20, Math.max(1, Math.round(Number(e.target.value) || 10))) } }
                              : s,
                          ),
                        }))
                      }
                      placeholder="10"
                      className="bg-transparent text-sm"
                    />
                  </div>
                  <p className="text-[11px] text-muted-foreground">Posts the top users ranked by that attribute (numbers only).</p>
                </div>
              ) : step.type === 'verify_join' ||
                step.type === 'streak' ||
                step.type === 'milestone' ||
                step.type === 'email_invite' ||
                step.type === 'email_unsubscribe' ? (
                <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  {step.type === 'verify_join'
                    ? `Join gate — the flow continues only after the user joins ${step.verifyJoin.chat}. Non-members get a join link and can retry.`
                    : step.type === 'streak'
                      ? `Daily streak — maintains the "${step.streak.attribute}" counter (+ its best record) once per UTC day. Show it with {{${step.streak.attribute}}}.`
                      : step.type === 'milestone'
                        ? `Milestone — when "${step.milestone.attribute}" first reaches ${step.milestone.value}, sends once: “${step.milestone.message.slice(0, 80)}${step.milestone.message.length > 80 ? '…' : ''}”`
                        : step.type === 'email_invite'
                          ? `Email invite — validates "${step.emailInvite.attribute}", records the consent and sends the invitation over the site's SMTP (queued when SMTP is not configured). Unsubscribes are honored forever.`
                          : 'Email unsubscribe — permanently removes every address this chat opted in with. An unsubscribe can never be undone by a re-opt-in.'}
                  {' '}Managed by NURAE — shown read-only here so it cannot be broken by edits.
                </p>
              ) : (
                <>
                  <Textarea
                    value={step.text}
                    onChange={(e) => patchStep(si, { text: e.target.value })}
                    placeholder="What should the bot say? (markdown works)"
                    rows={2}
                    maxLength={4000}
                    className="bg-transparent text-sm"
                  />
                  {step.buttons && (
                    <div className="space-y-2">
                      {step.buttons.map((b, bi) => (
                        <div key={bi} className="space-y-2 border-l border-border/60 pl-3">
                          <div className="grid gap-2 sm:grid-cols-[minmax(0,180px)_minmax(0,200px)_1fr]">
                            <Input
                              value={b.label}
                              onChange={(e) => patchButton(si, bi, { label: e.target.value })}
                              placeholder="Button text"
                              maxLength={64}
                              className="bg-transparent text-xs"
                            />
                            <select
                              value={b.action.kind}
                              onChange={(e) => {
                                const kind = e.target.value as BehaviorButtonActionDTO['kind'];
                                const action: BehaviorButtonActionDTO =
                                  kind === 'message'
                                    ? { kind: 'message', text: '' }
                                    : kind === 'link'
                                      ? { kind: 'link', url: '' }
                                      : kind === 'webapp'
                                        ? { kind: 'webapp', url: '' }
                                        : kind === 'copy'
                                          ? { kind: 'copy', text: '' }
                                          : kind === 'flow'
                                            ? { kind: 'flow', behaviorId: otherBehaviors[0]?.id ?? '' }
                                            : { kind: 'ai' };
                                patchButton(si, bi, { action });
                              }}
                              className="h-9 w-full rounded-md border border-border bg-transparent px-2 text-xs text-foreground outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
                            >
                              {ACTION_OPTIONS.map((o) => (
                                <option key={o.value} value={o.value} className="bg-background">{o.label}</option>
                              ))}
                            </select>
                            <button
                              type="button"
                              className="justify-self-start text-[11px] text-muted-foreground hover:text-destructive sm:justify-self-end"
                              onClick={() =>
                                patchStep(si, {
                                  buttons: (step.buttons ?? []).filter((_, idx) => idx !== bi),
                                })
                              }
                            >
                              Remove
                            </button>
                          </div>
                          {b.action.kind === 'message' && (
                            <Textarea
                              value={b.action.text}
                              onChange={(e) => patchButton(si, bi, { action: { kind: 'message', text: e.target.value } })}
                              placeholder={`What should “${b.label || 'this button'}” show?`}
                              rows={2}
                              maxLength={4000}
                              className="bg-transparent text-sm"
                            />
                          )}
                          {b.action.kind === 'link' && (
                            <Input
                              value={b.action.url}
                              onChange={(e) => patchButton(si, bi, { action: { kind: 'link', url: e.target.value } })}
                              placeholder="https://…"
                              maxLength={256}
                              className="bg-transparent font-mono text-xs"
                            />
                          )}
                          {b.action.kind === 'webapp' && (
                            <div className="space-y-1">
                              <Input
                                value={b.action.url}
                                onChange={(e) => patchButton(si, bi, { action: { kind: 'webapp', url: e.target.value } })}
                                placeholder="https://your-mini-app…"
                                maxLength={256}
                                className="bg-transparent font-mono text-xs"
                              />
                              <p className="text-[11px] text-muted-foreground">Opens inside Telegram as a Mini App. The URL must be HTTPS.</p>
                            </div>
                          )}
                          {b.action.kind === 'copy' && (
                            <Input
                              value={b.action.text}
                              onChange={(e) => patchButton(si, bi, { action: { kind: 'copy', text: e.target.value } })}
                              placeholder="Text copied when pressed (codes, addresses…)"
                              maxLength={200}
                              className="bg-transparent text-xs"
                            />
                          )}
                          {b.action.kind === 'flow' && (
                            <div className="space-y-1">
                              <select
                                value={b.action.behaviorId}
                                onChange={(e) => patchButton(si, bi, { action: { kind: 'flow', behaviorId: e.target.value } })}
                                className="h-9 w-full max-w-xs rounded-md border border-border bg-transparent px-2 text-xs text-foreground outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
                              >
                                <option value="" className="bg-background">Pick a flow…</option>
                                {otherBehaviors.map((ob) => (
                                  <option key={ob.id} value={ob.id} className="bg-background">{ob.title}</option>
                                ))}
                              </select>
                              {otherBehaviors.length === 0 && (
                                <p className="text-[11px] text-muted-foreground">
                                  No other behavior yet — add one below (e.g. “When a button is pressed → Menu”), then pick it here.
                                </p>
                              )}
                            </div>
                          )}
                          {b.action.kind === 'ai' && (
                            <Input
                              value={b.action.instruction ?? ''}
                              onChange={(e) => patchButton(si, bi, { action: { kind: 'ai', instruction: e.target.value } })}
                              placeholder="Optional guidance for the AI"
                              maxLength={2000}
                              className="bg-transparent text-xs"
                            />
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  <button
                    type="button"
                    className="text-[11px] text-muted-foreground hover:text-foreground"
                    onClick={() =>
                      patchStep(si, { buttons: [...(step.buttons ?? []), { label: '', action: { kind: 'message', text: '' } }] })
                    }
                  >
                    + Add button
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-3 pt-1">
          <button
            type="button"
            className="text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() =>
              setDraft((d) => ({ ...d, steps: [...d.steps, { type: 'message', text: '' } as BehaviorStepDTO] }))
            }
          >
            + Message
          </button>
          <button
            type="button"
            className="text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => setDraft((d) => ({ ...d, steps: [...d.steps, { type: 'ai' } as BehaviorStepDTO] }))}
          >
            + AI answer
          </button>
          <button
            type="button"
            className="text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() =>
              setDraft((d) => ({
                ...d,
                steps: [...d.steps, { type: 'media', media: { kind: 'photo', source: '' } } as BehaviorStepDTO],
              }))
            }
          >
            + Photo / file
          </button>
          <button
            type="button"
            className="text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() =>
              setDraft((d) => ({
                ...d,
                steps: [...d.steps, { type: 'poll', poll: { question: '', options: ['', ''] } } as BehaviorStepDTO],
              }))
            }
          >
            + Poll
          </button>
          <button
            type="button"
            className="text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() =>
              setDraft((d) => ({
                ...d,
                steps: [...d.steps, { type: 'payment', payment: { title: '', description: '', priceStars: 1 } } as BehaviorStepDTO],
              }))
            }
          >
            + Stars payment
          </button>
          <button
            type="button"
            className="text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() =>
              setDraft((d) => ({
                ...d,
                steps: [...d.steps, { type: 'collect', collect: { attribute: '' } } as BehaviorStepDTO],
              }))
            }
          >
            + Ask &amp; remember
          </button>
          <button
            type="button"
            className="text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() =>
              setDraft((d) => ({
                ...d,
                steps: [...d.steps, { type: 'schedule', schedule: {} } as BehaviorStepDTO],
              }))
            }
          >
            + Reminder
          </button>
          <button
            type="button"
            className="text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() =>
              setDraft((d) => ({
                ...d,
                steps: [...d.steps, { type: 'remember', remember: { attribute: '', value: 'yes', mode: 'set' } } as BehaviorStepDTO],
              }))
            }
          >
            + Remember
          </button>
          <button
            type="button"
            className="text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() =>
              setDraft((d) => ({
                ...d,
                steps: [...d.steps, { type: 'draw', draw: { attribute: '' } } as BehaviorStepDTO],
              }))
            }
          >
            + Draw winner
          </button>
          <button
            type="button"
            className="text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() =>
              setDraft((d) => ({
                ...d,
                steps: [...d.steps, { type: 'top', top: { attribute: '' } } as BehaviorStepDTO],
              }))
            }
          >
            + Leaderboard
          </button>
        </div>
      </div>

      {error && <p className="text-xs text-destructive" role="alert">{error}</p>}

      <div className="flex items-center gap-3">
        <Button size="sm" onClick={submit} disabled={saving}>
          {saving ? 'Saving…' : 'Save behavior'}
        </Button>
        <button type="button" onClick={onCancel} className="text-xs text-muted-foreground hover:text-foreground">
          Cancel
        </button>
      </div>
    </div>
  );
}
