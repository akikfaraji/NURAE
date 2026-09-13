'use client';

/**
 * NURAE — /bots: what has been built. List + the two creation paths.
 *
 *   Create bot      → manual configuration (/bots/new)
 *   Create with AI  → describe it; the Bot Builder agent configures it
 *
 * The list is typographic rows (name, handle, status dot) — no card grid.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { SiteHeader, SiteSplash, useSiteUser } from '@/components/nurae/site-shell';
import { ApiError, SessionUserDTO, UserBotDTO, nuraeApi } from '@/lib/nurae-client/api';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

export function BotsListView() {
  const { user, checked, signOut } = useSiteUser();
  const router = useRouter();
  const [bots, setBots] = useState<UserBotDTO[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!user) return;
    nuraeApi
      .listMyBots()
      .then((r) => setBots(r.bots))
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, [user]);

  if (!checked) return <SiteSplash />;

  if (!user) {
    return (
      <PublicGate title="Sign in to manage bots" body="Your bots, their configuration and their Telegram connections live in your account." />
    );
  }

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <SiteHeader user={user} onSignOut={signOut} />
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-10 sm:px-6">
        <div className="flex flex-wrap items-baseline justify-between gap-4">
          <div>
            <h1 className="text-xl font-medium tracking-tight text-foreground">Bots</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              What you have built. Configuration, testing and publishing live on each bot.
            </p>
          </div>
          <div className="flex gap-2">
            <Link href="/bots/new">
              <Button size="sm" variant="outline">Create bot</Button>
            </Link>
            <Link href="/bots/new?ai=1">
              <Button size="sm">Create with AI</Button>
            </Link>
          </div>
        </div>

        {!loaded ? (
          <p className="mt-10 text-xs text-muted-foreground">Loading…</p>
        ) : bots.length === 0 ? (
          <div className="mt-16 max-w-lg">
            <p className="text-sm leading-relaxed text-muted-foreground">
              No bots yet. Describe one in a sentence —
              <span className="text-foreground"> “a bot for my clothing store that answers product questions” </span>
              — and the Bot Builder agent drafts it for you, or configure one by hand.
            </p>
          </div>
        ) : (
          <ul className="mt-8 border-t border-border/60">
            {bots.map((b) => (
              <li key={b.id} className="border-b border-border/60">
                <Link
                  href={`/bots/${b.id}`}
                  className="group flex items-center gap-4 py-3 transition-colors hover:bg-muted/30"
                >
                  <span
                    aria-hidden
                    className={
                      'h-1.5 w-1.5 shrink-0 rounded-full ' +
                      (b.status === 'running'
                        ? 'animate-pulse bg-foreground'
                        : b.status === 'error'
                          ? 'bg-destructive'
                          : 'bg-muted-foreground/40')
                    }
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-foreground">{b.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {b.telegramUsername ?? (b.hasTelegramToken ? 'token set' : 'no token yet')}
                      {' · '}
                      {b.provider}/{b.model}
                    </span>
                  </span>
                  <span className="hidden text-xs text-muted-foreground sm:block">
                    {b.commands.length > 0 && `${b.commands.length} cmd · `}
                    {b.replies.length > 0 && `${b.replies.length} rules · `}
                    {b.status}
                  </span>
                  <span className="text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
                    →
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}

/** The "Create with AI" surface — a description, then straight to the agent. */
export function BotCreateView() {
  const { user, checked, signOut } = useSiteUser();
  const router = useRouter();
  const params = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
  const aiMode = params.get('ai') === '1';
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createWithAI = useCallback(async () => {
    const text = description.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { session } = await nuraeApi.createAgentSession(text.slice(0, 60));
      // Fire the agent's first turn with the description.
      await nuraeApi.sendAgentMessage(session.id, text).catch(() => undefined);
      router.push(`/chats/agents?session=${session.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the agent.');
      setBusy(false);
    }
  }, [description, busy, router]);

  if (!checked) return <SiteSplash />;

  if (!user) {
    return <PublicGate title="Sign in to create bots" body="Bot drafts, tokens and publishing are tied to your account." />;
  }

  if (aiMode) {
    return (
      <div className="flex min-h-dvh flex-col bg-background">
        <SiteHeader user={user} onSignOut={signOut} />
        <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-12 sm:px-6">
          <h1 className="text-xl font-medium tracking-tight text-foreground">Describe your bot</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            One or two sentences are enough. The Bot Builder agent turns this into a real
            configuration — identity, commands, buttons, AI behavior — and you review everything
            before it goes live.
          </p>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={2000}
            rows={5}
            autoFocus
            placeholder="Create a Telegram bot for my clothing store that answers product questions, shows products and lets customers contact us."
            className="mt-6 border-border bg-transparent text-sm"
          />
          {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
          <div className="mt-4 flex items-center gap-3">
            <Button size="sm" disabled={busy || !description.trim()} onClick={() => void createWithAI()}>
              {busy ? 'Starting the agent…' : 'Build with the agent'}
            </Button>
            <Link href="/bots/new" className="text-xs text-muted-foreground hover:text-foreground">
              Configure manually instead
            </Link>
          </div>
        </main>
      </div>
    );
  }

  return <BotManualForm user={user} onSignOut={signOut} />;
}

// ---------------------------------------------------------------------------
// Manual creation — minimal, real fields only
// ---------------------------------------------------------------------------

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

function BotManualForm({ user, onSignOut }: { user: SessionUserDTO; onSignOut?: () => void }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [token, setToken] = useState('');
  const [systemPrompt, setSystemPrompt] = useState(
    'You are a helpful assistant. Answer clearly and concisely.',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFields({});
    try {
      const { bot } = await nuraeApi.createMyBot({
        name,
        description,
        systemPrompt,
        ...(token.trim() ? { telegramToken: token.trim() } : {}),
      });
      router.push(`/bots/${bot.id}`);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFields(err.fields ?? {});
      } else {
        setError('Could not create the bot.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <SiteHeader user={user} onSignOut={onSignOut} />
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-12 sm:px-6">
        <h1 className="text-xl font-medium tracking-tight text-foreground">New bot</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          You can leave the token empty — the bot saves as a draft until you connect Telegram.
        </p>
        <form onSubmit={submit} className="mt-8 space-y-5">
          <div className="space-y-1.5">
            <Label htmlFor="bot-name" className="text-xs text-muted-foreground">Name</Label>
            <Input id="bot-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} className="bg-transparent" />
            {fields.name && <p className="text-xs text-destructive">{fields.name}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bot-desc" className="text-xs text-muted-foreground">Description <span className="opacity-60">(optional)</span></Label>
            <Input id="bot-desc" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} className="bg-transparent" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bot-token" className="text-xs text-muted-foreground">
              Telegram bot token <span className="opacity-60">(from @BotFather — stored encrypted)</span>
            </Label>
            <Input
              id="bot-token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="1234567890:AA…"
              className="bg-transparent font-mono text-xs"
              autoComplete="off"
            />
            {fields.telegramToken && <p className="text-xs text-destructive">{fields.telegramToken}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bot-prompt" className="text-xs text-muted-foreground">System prompt (how the bot behaves)</Label>
            <Textarea
              id="bot-prompt"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={5}
              maxLength={8000}
              className="bg-transparent text-sm"
            />
            {fields.systemPrompt && <p className="text-xs text-destructive">{fields.systemPrompt}</p>}
          </div>
          {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
          <div className="flex items-center gap-3">
            <Button type="submit" size="sm" disabled={busy}>{busy ? 'Creating…' : 'Create draft'}</Button>
            <Link href="/bots" className="text-xs text-muted-foreground hover:text-foreground">Back to bots</Link>
          </div>
        </form>
      </main>
    </div>
  );
}

function PublicGate({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <SiteHeader variant="public" user={null} />
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-16">
        <h1 className="text-lg font-medium text-foreground">{title}</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{body}</p>
        <Link href="/" className="mt-6 inline-flex w-fit">
          <Button size="sm">Sign in</Button>
        </Link>
      </main>
    </div>
  );
}
