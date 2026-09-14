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
      const btns = s.buttons?.length ? ` + ${s.buttons.length} button${s.buttons.length === 1 ? '' : 's'}` : '';
      const excerpt = s.text.length > 48 ? `${s.text.slice(0, 48).trimEnd()}…` : s.text;
      return `“${excerpt}”${btns}`;
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
                <span className="ml-auto flex gap-3 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
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
  { value: 'anything_else', label: 'anything else' },
];

const ACTION_OPTIONS: Array<{ value: BehaviorButtonActionDTO['kind']; label: string }> = [
  { value: 'message', label: 'Show a message' },
  { value: 'link', label: 'Open a link' },
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
        }
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
                        : type === 'button'
                          ? { type: 'button' }
                          : { type: 'anything_else' },
              }));
            }}
            className="h-9 w-full border border-border bg-transparent px-2 text-sm text-foreground"
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
                  {step.type === 'message' ? `Message ${si + 1}` : 'AI answer'}
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
                                      : kind === 'flow'
                                        ? { kind: 'flow', behaviorId: otherBehaviors[0]?.id ?? '' }
                                        : { kind: 'ai' };
                                patchButton(si, bi, { action });
                              }}
                              className="h-9 w-full border border-border bg-transparent px-2 text-xs text-foreground"
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
                          {b.action.kind === 'flow' && (
                            <div className="space-y-1">
                              <select
                                value={b.action.behaviorId}
                                onChange={(e) => patchButton(si, bi, { action: { kind: 'flow', behaviorId: e.target.value } })}
                                className="h-9 w-full max-w-xs border border-border bg-transparent px-2 text-xs text-foreground"
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
        <div className="flex gap-3 pt-1">
          <button
            type="button"
            className="text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() =>
              setDraft((d) => ({ ...d, steps: [...d.steps, { type: 'message', text: '' } as BehaviorStepDTO] }))
            }
          >
            + Add message step
          </button>
          <button
            type="button"
            className="text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => setDraft((d) => ({ ...d, steps: [...d.steps, { type: 'ai' } as BehaviorStepDTO] }))}
          >
            + Add AI answer step
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
