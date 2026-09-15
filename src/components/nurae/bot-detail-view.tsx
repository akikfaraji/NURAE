'use client';

/**
 * NURAE — /bots/[id]: one bot, end to end.
 *
 * Sections (Behavior is the primary surface — the technical layer is underneath):
 *   header row    name · status · run / stop / restart (run = go live)
 *   behavior      what the bot does, in plain language (the source of truth)
 *   preview       a REAL pipeline turn — exactly what Telegram will deliver
 *   configuration identity + AI settings (token/key write-only)
 *   advanced      raw commands / replies (escape hatch; a later behavior save recompiles)
 *   danger zone   archive / delete (two-step)
 *
 * Everything talks to ownership-checked /api/my/bots endpoints.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { SiteHeader, SiteSplash, useSiteUser } from '@/components/nurae/site-shell';
import { Markdown } from '@/components/nurae/markdown';
import { BehaviorSection } from '@/components/nurae/bot-behavior-section';
import { AudienceSection, BroadcastSection, PaymentsSection, SchedulesSection } from '@/components/nurae/bot-ecosystem-sections';
import {
  ApiError,
  CapturedSendDTO,
  Catalog,
  UserBotDTO,
  nuraeApi,
} from '@/lib/nurae-client/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

type Command = UserBotDTO['commands'][number];
type Reply = UserBotDTO['replies'][number];

export function BotDetailView() {
  const { user, checked, signOut } = useSiteUser();
  const paramsRef = useParams<{ id: string }>();
  const botId = paramsRef.id;
  const router = useRouter();

  const [bot, setBot] = useState<UserBotDTO | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [catalog, setCatalog] = useState<Catalog | null>(null);

  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await nuraeApi.getMyBot(botId);
      setBot(r.bot);
      setLoadError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setNotFound(true);
      else setLoadError(err instanceof Error ? err.message : 'Could not load the bot.');
    }
  }, [botId]);

  useEffect(() => {
    (async () => {
      if (user) {
        await load();
      }
    })();
    nuraeApi.catalog().then(setCatalog).catch(() => undefined);
  }, [user, load]);

  const patch = async (input: Record<string, unknown>) => {
    setSaving(true);
    setError(null);
    try {
      const r = await nuraeApi.updateMyBot(botId, input);
      setBot(r.bot);
      setSavedAt(new Date().toLocaleTimeString());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  const publish = async () => {
    setSaving(true);
    setError(null);
    try {
      await nuraeApi.publishMyBot(botId);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Publish failed.');
    } finally {
      setSaving(false);
    }
  };

  const unpublish = async () => {
    setSaving(true);
    setError(null);
    try {
      await nuraeApi.unpublishMyBot(botId);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Stop failed.');
    } finally {
      setSaving(false);
    }
  };

  const restart = async () => {
    setSaving(true);
    setError(null);
    try {
      await nuraeApi.restartMyBot(botId);
      await load();
      setSavedAt(new Date().toLocaleTimeString());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Restart failed.');
    } finally {
      setSaving(false);
    }
  };

  const archive = async () => {
    await nuraeApi.updateMyBot(botId, { archived: true }).catch(() => undefined);
    router.push('/bots');
  };

  const remove = async () => {
    await nuraeApi.deleteMyBot(botId).catch(() => undefined);
    router.push('/bots');
  };

  if (!checked) return <SiteSplash />;

  if (!user) {
    return (
      <div className="flex min-h-dvh flex-col bg-background">
        <SiteHeader variant="public" user={null} />
        <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-16">
          <h1 className="text-lg font-medium text-foreground">Sign in</h1>
          <Link href="/" className="mt-6 inline-flex w-fit"><Button size="sm">Sign in</Button></Link>
        </main>
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="flex min-h-dvh flex-col bg-background">
        <SiteHeader user={user} onSignOut={signOut} />
        <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-16">
          <p className="text-sm text-muted-foreground">
            This bot does not exist — or it belongs to another account.
          </p>
          <Link href="/bots" className="mt-4 inline-block text-xs text-foreground underline-offset-4 hover:underline">
            ← Back to bots
          </Link>
        </main>
      </div>
    );
  }

  if (!bot) {
    return (
      <div className="flex min-h-dvh flex-col bg-background">
        <SiteHeader user={user} onSignOut={signOut} />
        <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-16">
          <p className="text-xs text-muted-foreground">{loadError ?? 'Loading…'}</p>
        </main>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <SiteHeader user={user} onSignOut={signOut} />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6">
        {/* Header row */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Link href="/bots" className="text-xs text-muted-foreground hover:text-foreground">← Bots</Link>
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <span
              aria-hidden
              className={
                'h-1.5 w-1.5 rounded-full ' +
                (bot.status === 'running' ? 'animate-pulse bg-foreground' : bot.status === 'error' ? 'bg-destructive' : 'bg-muted-foreground/40')
              }
            />
            {bot.status}
            {bot.telegramUsername ? ` · ${bot.telegramUsername}` : ''}
          </span>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            {bot.status === 'running' ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={saving}
                  title="Stop the bot — it stops answering on Telegram until you run it again"
                  onClick={() => void unpublish()}
                >
                  Stop
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={saving}
                  title="Restart — reloads the bot's configuration and re-registers the Telegram webhook"
                  onClick={() => void restart()}
                >
                  {saving ? '…' : 'Restart'}
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                disabled={saving}
                title="Put the bot live on Telegram — it starts answering right away"
                onClick={() => void publish()}
              >
                {saving ? '…' : bot.status === 'stopped' || bot.status === 'error' ? 'Run' : 'Publish'}
              </Button>
            )}
          </div>
        </div>
        <h1 className="mt-3 text-xl font-medium tracking-tight text-foreground">{bot.name}</h1>
        {bot.statusDetail && (
          <p className="mt-1 text-xs text-destructive">{bot.statusDetail}</p>
        )}
        {savedAt && <p className="mt-1 text-[11px] text-muted-foreground">Saved {savedAt}</p>}
        {error && <p className="mt-1 text-xs text-destructive" role="alert">{error}</p>}

        {/* Behavior — the primary surface */}
        <BehaviorSection bot={bot} saving={saving} onSave={patch} />

        {/* Preview — the real pipeline */}
        <PreviewSection bot={bot} />

        {/* Ecosystem — audience, reach, rhythm, money */}
        <AudienceSection botId={botId} refreshKey={0} />
        <BroadcastSection botId={botId} refreshKey={0} onSent={() => void load()} />
        <SchedulesSection botId={botId} refreshKey={0} />
        <PaymentsSection botId={botId} refreshKey={0} />

        {/* Configuration */}
        <ConfigSection bot={bot} catalog={catalog} saving={saving} onSave={patch} />

        {/* Advanced — the technical layer, by choice */}
        <details className="mt-12 border-t border-border/60 pt-6">
          <summary className="cursor-pointer text-xs font-medium uppercase tracking-widest text-muted-foreground hover:text-foreground">
            Advanced · commands &amp; replies
          </summary>
          <p className="mt-2 max-w-2xl text-xs leading-relaxed text-muted-foreground/80">
            The technical internals that Behaviors compile into. You can edit them by hand —
            note that the next change to Behaviors recompiles and replaces them.
          </p>
          <CommandsSection bot={bot} saving={saving} onSave={patch} />
          <RepliesSection bot={bot} saving={saving} onSave={patch} />
        </details>

        {/* Danger zone */}
        <section className="mt-12 border-t border-border/60 pt-6">
          <h2 className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Danger zone</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            <DangerButton label={bot.archived ? 'Unarchive' : 'Archive'} onConfirm={() => void patch({ archived: !bot.archived })} />
            <DangerButton label="Delete bot" destructive onConfirm={() => void remove()} />
          </div>
        </section>
      </main>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="mt-10 border-t border-border/60 pt-6">
      <h2 className="text-xs font-medium uppercase tracking-widest text-muted-foreground">{title}</h2>
      {hint && <p className="mt-1 text-xs leading-relaxed text-muted-foreground/80">{hint}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function ConfigSection({
  bot,
  catalog,
  saving,
  onSave,
}: {
  bot: UserBotDTO;
  catalog: Catalog | null;
  saving: boolean;
  onSave: (patch: Record<string, unknown>) => void;
}) {
  const [name, setName] = useState(bot.name);
  const [description, setDescription] = useState(bot.description);
  const [systemPrompt, setSystemPrompt] = useState(bot.systemPrompt);
  const [provider, setProvider] = useState(bot.provider);
  const [model, setModel] = useState(bot.model);
  const [temperature, setTemperature] = useState(String(bot.temperature));
  const [maxTokens, setMaxTokens] = useState(String(bot.maxTokens));
  const [memorySize, setMemorySize] = useState(String(bot.memorySize));
  const [token, setToken] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [ownerChatId, setOwnerChatId] = useState(bot.ownerChatId ?? '');
  const [testingAlert, setTestingAlert] = useState(false);

  // Reset local fields when the bot record changes (render-phase update —
  // the React-sanctioned alternative to a setState-in-effect). 
  const [prevBotId, setPrevBotId] = useState(bot.id);
  const [prevUpdated, setPrevUpdated] = useState(bot.updatedAt);
  if (prevBotId !== bot.id || prevUpdated !== bot.updatedAt) {
    setPrevBotId(bot.id);
    setPrevUpdated(bot.updatedAt);
    setName(bot.name);
    setDescription(bot.description);
    setSystemPrompt(bot.systemPrompt);
    setProvider(bot.provider);
    setModel(bot.model);
    setTemperature(String(bot.temperature));
    setMaxTokens(String(bot.maxTokens));
    setMemorySize(String(bot.memorySize));
    setOwnerChatId(bot.ownerChatId ?? '');
  }

  const providerInfo = catalog?.providers.find((p) => p.id === provider);

  return (
    <Section title="Configuration" hint="The bot must be stopped before transport changes apply — configuration saves instantly.">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} className="bg-transparent" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Description</Label>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} className="bg-transparent" />
        </div>
      </div>
      <div className="mt-4 space-y-1.5">
        <Label className="text-xs text-muted-foreground">System prompt</Label>
        <Textarea value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} rows={5} maxLength={8000} className="bg-transparent text-sm" />
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">AI provider</Label>
          <select
            value={provider}
            onChange={(e) => {
              const p = catalog?.providers.find((x) => x.id === e.target.value);
              setProvider(e.target.value);
              if (p) setModel(p.defaultModel);
            }}
            className="h-9 w-full rounded-md border border-border bg-transparent px-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
          >
            {(catalog?.providers ?? []).map((p) => (
              <option key={p.id} value={p.id} className="bg-background">{p.label}</option>
            ))}
            {!catalog && <option value={provider} className="bg-background">{provider}</option>}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Model</Label>
          <Input value={model} onChange={(e) => setModel(e.target.value)} maxLength={200} className="bg-transparent font-mono text-xs" list="model-list" />
          <datalist id="model-list">
            {(providerInfo?.models ?? []).map((m) => <option key={m} value={m} />)}
          </datalist>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Temperature (0–2)</Label>
          <Input type="number" step="0.1" min={0} max={2} value={temperature} onChange={(e) => setTemperature(e.target.value)} className="bg-transparent" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Max tokens</Label>
          <Input type="number" min={1} max={100000} value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} className="bg-transparent" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Memory (recent messages kept)</Label>
          <Input type="number" min={1} max={50} value={memorySize} onChange={(e) => setMemorySize(e.target.value)} className="bg-transparent" />
        </div>
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">
            Telegram token {bot.hasTelegramToken ? <span className="text-foreground/60">· set — leave empty to keep</span> : '· missing'}
          </Label>
          <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={bot.hasTelegramToken ? '••••••' : '1234567890:AA…'} autoComplete="off" className="bg-transparent font-mono text-xs" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">
            AI provider key {bot.hasApiKey ? <span className="text-foreground/60">· set — leave empty to keep</span> : ''}
          </Label>
          <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-or-…" autoComplete="off" className="bg-transparent font-mono text-xs" />
        </div>
      </div>
      <div className="mt-4 rounded-md border border-border/70 p-3">
        <p className="text-xs font-medium text-foreground">Instant updates in your Telegram</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Every completed order, form and Stars payment is pushed to your own Telegram the moment it happens.
          Message <span className="font-mono">@userinfobot</span> to get your numeric chat id, paste it below, save, then send a test.
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="min-w-40 flex-1 space-y-1.5">
            <Label className="text-xs text-muted-foreground">
              Your chat id {bot.ownerChatId ? <span className="text-foreground/60">· wired to {bot.ownerChatId}</span> : '· not set'}
            </Label>
            <Input
              value={ownerChatId}
              onChange={(e) => setOwnerChatId(e.target.value.replace(/[^\d]/g, ''))}
              placeholder="e.g. 6123456789"
              inputMode="numeric"
              className="bg-transparent font-mono text-xs"
            />
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={saving}
            onClick={() => onSave({ ownerChatId: ownerChatId.trim() })}
          >
            {saving ? 'Saving…' : 'Save alert wiring'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={testingAlert}
            onClick={async () => {
              setTestingAlert(true);
              try {
                await nuraeApi.testOwnerAlert(bot.id);
                toast.success('Test alert sent — check your Telegram');
              } catch (err) {
                toast.error(err instanceof Error ? err.message : 'Test failed');
              } finally {
                setTestingAlert(false);
              }
            }}
          >
            {testingAlert ? 'Sending…' : 'Send test'}
          </Button>
        </div>
      </div>
      <div className="mt-5">
        <Button
          size="sm"
          variant="outline"
          disabled={saving}
          onClick={() =>
            onSave({
              name,
              description,
              systemPrompt,
              provider,
              model,
              temperature: Number(temperature) || 0.7,
              maxTokens: Number(maxTokens) || 1024,
              memorySize: Number(memorySize) || 10,
              ...(token.trim() ? { telegramToken: token.trim() } : {}),
              ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
            })
          }
        >
          {saving ? 'Saving…' : 'Save configuration'}
        </Button>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function CommandsSection({ bot, saving, onSave }: { bot: UserBotDTO; saving: boolean; onSave: (patch: Record<string, unknown>) => void }) {
  const [commands, setCommands] = useState<Command[]>(bot.commands);
  const [prevVersion, setPrevVersion] = useState(`${bot.id}:${bot.updatedAt}`);
  if (prevVersion !== `${bot.id}:${bot.updatedAt}`) {
    setPrevVersion(`${bot.id}:${bot.updatedAt}`);
    setCommands(bot.commands);
  }

  const update = (i: number, patch: Partial<Command>) =>
    setCommands((cs) => cs.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));

  return (
    <Section
      title="Menu commands"
      hint="Registered with Telegram when the bot starts (the / menu). static replies with your text; ai feeds the text to the model as guidance."
    >
      {commands.length === 0 && <p className="text-xs text-muted-foreground">No custom commands yet.</p>}
      <div className="space-y-4">
        {commands.map((c, i) => (
          <div key={i} className="grid gap-2 border border-border/60 p-3 sm:grid-cols-[140px_1fr]">
            <div className="space-y-2">
              <Input
                value={c.command}
                onChange={(e) => update(i, { command: e.target.value })}
                placeholder="/pricing"
                className="bg-transparent font-mono text-xs"
                maxLength={33}
              />
              <Input
                value={c.description}
                onChange={(e) => update(i, { description: e.target.value })}
                placeholder="Show pricing"
                className="bg-transparent text-xs"
                maxLength={64}
              />
              <select
                value={c.kind}
                onChange={(e) => update(i, { kind: e.target.value as Command['kind'] })}
                className="h-8 w-full rounded-md border border-border bg-transparent px-2 text-xs text-foreground outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
              >
                <option value="static" className="bg-background">static reply</option>
                <option value="ai" className="bg-background">AI-guided</option>
              </select>
              <button
                type="button"
                onClick={() => setCommands((cs) => cs.filter((_, idx) => idx !== i))}
                className="text-[11px] text-muted-foreground hover:text-destructive"
              >
                Remove
              </button>
            </div>
            <Textarea
              value={c.response}
              onChange={(e) => update(i, { response: e.target.value })}
              placeholder={c.kind === 'static' ? 'The exact reply (markdown works).' : 'Extra instruction for the AI on this command.'}
              rows={3}
              maxLength={4000}
              className="bg-transparent text-sm"
            />
          </div>
        ))}
      </div>
      <div className="mt-4 flex gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={saving}
          onClick={() => onSave({ commands })}
        >
          {saving ? 'Saving…' : 'Save commands'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setCommands((cs) => [...cs, { command: '/', description: '', kind: 'static', response: '' }])}
        >
          + Add command
        </Button>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Replies — buttons, keywords, fallbacks, workflows
// ---------------------------------------------------------------------------

function RepliesSection({ bot, saving, onSave }: { bot: UserBotDTO; saving: boolean; onSave: (patch: Record<string, unknown>) => void }) {
  const [replies, setReplies] = useState<Reply[]>(bot.replies);
  const [parseError, setParseError] = useState<string | null>(null);
  const [prevVersion, setPrevVersion] = useState(`${bot.id}:${bot.updatedAt}`);
  if (prevVersion !== `${bot.id}:${bot.updatedAt}`) {
    setPrevVersion(`${bot.id}:${bot.updatedAt}`);
    setReplies(bot.replies);
  }

  const update = (i: number, patch: Partial<Reply>) =>
    setReplies((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  return (
    <Section
      title="Replies, buttons & workflows"
      hint="A reply triggers on a command, a keyword, an inline button press, or acts as the fallback. Multiple messages = a workflow (sent in order). Buttons: one per line as Label => r:callback (paired with a button-trigger reply) or Label => https://url."
    >
      {replies.length === 0 && <p className="text-xs text-muted-foreground">No response rules yet.</p>}
      <div className="space-y-4">
        {replies.map((r, i) => (
          <div key={i} className="space-y-3 border border-border/60 p-3">
            <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto_1fr]">
              <Input
                value={r.name}
                onChange={(e) => update(i, { name: e.target.value })}
                placeholder="Rule name"
                className="bg-transparent text-xs"
                maxLength={100}
              />
              <select
                value={r.trigger.type}
                onChange={(e) => {
                  const type = e.target.value as Reply['trigger']['type'];
                  update(i, {
                    trigger: {
                      type,
                      value: type === 'button' && !(r.trigger.value ?? '').startsWith('r:')
                        ? `r:${r.trigger.value ?? ''}`
                        : r.trigger.value,
                    },
                  });
                }}
                className="h-9 rounded-md border border-border bg-transparent px-2 text-xs text-foreground outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
              >
                <option value="command" className="bg-background">on command</option>
                <option value="keyword" className="bg-background">on keyword</option>
                <option value="button" className="bg-background">on button</option>
                <option value="fallback" className="bg-background">fallback</option>
              </select>
              {r.trigger.type !== 'fallback' && (
                <Input
                  value={r.trigger.value ?? ''}
                  onChange={(e) => update(i, { trigger: { ...r.trigger, value: e.target.value } })}
                  placeholder={r.trigger.type === 'button' ? 'r:products' : r.trigger.type === 'command' ? '/menu' : 'price'}
                  className="bg-transparent font-mono text-xs"
                  maxLength={64}
                />
              )}
              <button
                type="button"
                onClick={() => setReplies((rs) => rs.filter((_, idx) => idx !== i))}
                className="justify-self-start text-[11px] text-muted-foreground hover:text-destructive sm:justify-self-end"
              >
                Remove
              </button>
            </div>
            {r.messages.map((m, mi) => (
              <div key={mi} className="space-y-1.5">
                <Textarea
                  value={m.text}
                  onChange={(e) =>
                    update(i, {
                      messages: r.messages.map((x, xi) => (xi === mi ? { ...x, text: e.target.value } : x)),
                    })
                  }
                  placeholder={r.messages.length > 1 ? `Workflow step ${mi + 1}` : 'Message text (markdown works).'}
                  rows={2}
                  maxLength={4000}
                  className="bg-transparent text-sm"
                />
                <Textarea
                  value={(m.buttons ?? []).map((row) => row.map((b) => `${b.text} => ${b.callback ?? b.url}`).join('\n')).join('\n---\n')}
                  onChange={(e) => {
                    try {
                      const rows = e.target.value.split(/\n---\n/).map((row) =>
                        row
                          .split('\n')
                          .map((line) => line.trim())
                          .filter(Boolean)
                          .map((line) => {
                            const [text, target] = line.split('=>').map((s) => s.trim());
                            if (!text || !target) throw new Error('Use: Label => r:callback or Label => https://url');
                            return target.startsWith('r:')
                              ? { text, callback: target }
                              : { text, url: target };
                          }),
                      );
                      update(i, {
                        messages: r.messages.map((x, xi) =>
                          xi === mi ? { ...x, buttons: rows.some((row) => row.length) ? rows : undefined } : x,
                        ),
                      });
                      setParseError(null);
                    } catch (err) {
                      setParseError(`Reply "${r.name}", step ${mi + 1}: ${(err as Error).message}`);
                    }
                  }}
                  placeholder={'Buttons (optional):\nProducts => r:products\nVisit us => https://example.com'}
                  rows={2}
                  className="bg-transparent font-mono text-[11px] text-muted-foreground"
                />
              </div>
            ))}
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => update(i, { messages: [...r.messages, { text: '' }] })}
                className="text-[11px] text-muted-foreground hover:text-foreground"
              >
                + workflow step
              </button>
            </div>
          </div>
        ))}
      </div>
      {parseError && <p className="mt-2 text-xs text-destructive" role="alert">{parseError}</p>}
      <div className="mt-4 flex gap-2">
        <Button size="sm" variant="outline" disabled={saving || Boolean(parseError)} onClick={() => onSave({ replies })}>
          {saving ? 'Saving…' : 'Save replies'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            setReplies((rs) => [
              ...rs,
              { id: `r${Date.now().toString(36)}`, name: '', trigger: { type: 'keyword', value: '' }, messages: [{ text: '' }] },
            ])
          }
        >
          + Add rule
        </Button>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Preview — the REAL pipeline, captured (talk to the bot before it goes live)
// ---------------------------------------------------------------------------

function PreviewSection({ bot }: { bot: UserBotDTO }) {
  const [draft, setDraft] = useState('');
  const [sends, setSends] = useState<CapturedSendDTO[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const send = async (input: { text?: string; callback?: string }) => {
    setBusy(true);
    setError(null);
    try {
      const r = await nuraeApi.testMyBot(bot.id, input);
      setSends((s) => [...s, ...r.sends]);
      if (r.error) setError(r.error);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Test failed.');
    } finally {
      setBusy(false);
      requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }));
    }
  };

  return (
    <Section
      title="Preview"
      hint="Talk to the bot before it goes live — this runs the real pipeline (behaviors, buttons, media, Stars) and shows exactly what Telegram will deliver. Nothing is sent anywhere."
    >
      <div ref={scrollRef} className="max-h-96 space-y-4 overflow-y-auto border border-border/60 p-4">
        {sends.length === 0 && (
          <p className="text-xs text-muted-foreground">
            Send a message below — try /start, a custom command, or press a button.
          </p>
        )}
        {sends.map((s, i) => (
          <div key={i} className="space-y-2">
            {s.kind === 'media' && s.media && (
              <p className="text-[11px] uppercase tracking-widest text-muted-foreground">
                {s.media.kind}{s.media.source.startsWith('http') ? '' : ' (file_id)'}
              </p>
            )}
            {s.kind === 'payment' && s.payment && (
              <p className="text-[11px] uppercase tracking-widest text-muted-foreground">
                stars invoice · {s.payment.priceStars} ★
              </p>
            )}
            {s.kind === 'edit' && (
              <p className="text-[11px] uppercase tracking-widest text-muted-foreground">edited in place</p>
            )}
            {s.kind === 'poll' && s.poll ? (
              <div>
                <p className="text-sm font-medium">{s.poll.question}{s.poll.quiz ? ' (quiz)' : ''}</p>
                <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                  {s.poll.options.map((o, oi) => <li key={oi}>· {o}</li>)}
                </ul>
              </div>
            ) : (
              <Markdown>{s.text}</Markdown>
            )}
            {s.buttons && (
              <div className="flex flex-wrap gap-1.5">
                {s.buttons.flatMap((row, ri) =>
                  row.map((b, bi) => (
                    <button
                      key={`${ri}-${bi}`}
                      type="button"
                      disabled={busy}
                      onClick={() => b.callback && void send({ callback: b.callback })}
                      className="border border-border px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-muted/60 disabled:opacity-50"
                    >
                      {b.text}
                      {b.webapp && ' ⧉'}
                      {!b.callback && !b.webapp && ' ↗'}
                    </button>
                  )),
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      {error && <p className="mt-2 text-xs text-destructive" role="alert">{error}</p>}
      <div className="mt-3 flex items-end gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && draft.trim() && !busy) {
              void send({ text: draft.trim() });
              setDraft('');
            }
          }}
          placeholder="/start or any message"
          className="bg-transparent text-sm"
          maxLength={4000}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !draft.trim()}
          onClick={() => {
            void send({ text: draft.trim() });
            setDraft('');
          }}
        >
          {busy ? '…' : 'Run'}
        </Button>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Danger
// ---------------------------------------------------------------------------

function DangerButton({ label, destructive, onConfirm }: { label: string; destructive?: boolean; onConfirm: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="ghost" className={destructive ? 'text-destructive hover:text-destructive' : ''} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent className="border-border bg-background">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-sm">{label} — are you sure?</AlertDialogTitle>
            <AlertDialogDescription className="text-xs text-muted-foreground">
              {label === 'Delete bot'
                ? 'The bot, its conversations and its logs are removed permanently.'
                : label === 'Archive'
                  ? 'Archived bots disappear from the list but keep their data.'
                  : 'The bot reappears in your list.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="text-xs">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={destructive ? 'bg-destructive text-xs text-white hover:bg-destructive/90' : 'text-xs'}
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              {label}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
