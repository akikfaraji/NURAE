'use client';

/**
 * NURAE — /bots: what has been built. List + the two creation paths.
 *
 *   Describe it (default) → the Bot Builder agent turns intent into a bot
 *   Start from scratch    → manual configuration (/bots/new)
 *
 * The list is typographic rows (name, handle, status dot) — no card grid.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { SiteHeader, SiteSplash, useSiteUser } from '@/components/nurae/site-shell';
import { ApiError, SessionUserDTO, UserBotDTO, nuraeApi } from '@/lib/nurae-client/api';
import { TEMPLATE_CATALOG } from '@/lib/nurae/bots/templates';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { LoadingRow, PageFade } from '@/components/nurae/bits';

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
        <PageFade>
        <div className="flex flex-wrap items-baseline justify-between gap-4">
          <div>
            <h1 className="text-xl font-medium tracking-tight text-foreground">Bots</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              What you have built. Configuration, testing and publishing live on each bot.
            </p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" asChild>
              <Link href="/bots/new?ai=1">New bot</Link>
            </Button>
            <Button size="sm" variant="outline" asChild>
              <Link href="/bots/new">Start from scratch</Link>
            </Button>
          </div>
        </div>

        <div className="mt-10 flex items-baseline justify-between gap-4">
          <p className="text-[11px] uppercase tracking-widest text-muted-foreground">Your bots</p>
          <span className="text-xs text-muted-foreground">{loaded ? bots.length : '…'}</span>
        </div>

        {!loaded ? (
          <div className="mt-4">
            <LoadingRow />
          </div>
        ) : bots.length === 0 ? (
          <div className="mt-6 max-w-lg">
            <p className="text-sm leading-relaxed text-muted-foreground">
              Say what the bot should do —
              <span className="text-foreground"> “when someone starts my restaurant bot, welcome them with buttons for Menu, Order and Contact” </span>
              — and NURAE builds it. You approve everything before it goes live, and can fine-tune every detail afterwards.
            </p>
            <div className="mt-4 flex gap-3">
              <Button size="sm" asChild>
                <Link href="/bots/new?ai=1">Describe a bot</Link>
              </Button>
              <Link href="#built-in" className="self-center text-xs text-muted-foreground hover:text-foreground">or start from a built-in bot below</Link>
            </div>
          </div>
        ) : (
          <ul className="mt-4 border-t border-border/60">
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
                    {b.behaviors.length > 0
                      ? `${b.behaviors.length} behavior${b.behaviors.length === 1 ? '' : 's'} · `
                      : b.commands.length > 0
                        ? `${b.commands.length} cmd · `
                        : ''}
                    {b.behaviors.length === 0 && b.replies.length > 0 ? `${b.replies.length} rules · ` : ''}
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

        <BuiltInBotsSection />
        </PageFade>
      </main>
    </div>
  );
}

/**
 * Built-in bots — five finished promotion templates, ready to instantiate.
 * Each one deploys with NURAE growth hooks baked in: an "About NURAE"
 * flow and a referral link that credits the owner for signups.
 */
function BuiltInBotsSection() {
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const instantiateTemplate = async (id: string) => {
    if (busy) return;
    setBusy(id);
    setError(null);
    try {
      const { bot } = await nuraeApi.createBotFromTemplate(id);
      router.push(`/bots/${bot.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the bot.');
      setBusy(null);
    }
  };

  return (
    <section id="built-in" className="mt-12 scroll-mt-16">
      <p className="text-[11px] uppercase tracking-widest text-muted-foreground">Built-in bots</p>
      <p className="mt-1 max-w-xl text-sm text-muted-foreground">
        Five finished bots for the classic jobs. Pick one — it arrives fully configured,
        you connect the token, it runs. Every bot you deploy links its users to NURAE.
      </p>
      <ul className="mt-4 border-t border-border/60">
        {TEMPLATE_CATALOG.map((t) => (
          <li key={t.id} className="border-b border-border/60">
            <button
              type="button"
              onClick={() => setOpen(open === t.id ? null : t.id)}
              aria-expanded={open === t.id}
              className="group flex w-full items-center gap-4 py-3 text-left transition-colors hover:bg-muted/30"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-foreground">{t.name}</span>
                <span className="block truncate text-xs text-muted-foreground">{t.tagline}</span>
              </span>
              <span className="hidden shrink-0 text-[11px] uppercase tracking-widest text-muted-foreground sm:block">
                {t.category}
              </span>
              <span aria-hidden className="w-4 shrink-0 text-center text-xs text-muted-foreground">
                {open === t.id ? '−' : '+'}
              </span>
            </button>
            {open === t.id && (
              <div className="max-w-2xl pb-4">
                <p className="text-sm leading-relaxed text-muted-foreground">{t.description}</p>
                <ul className="mt-3 space-y-1">
                  {t.highlights.map((h) => (
                    <li key={h} className="text-xs text-muted-foreground">· {h}</li>
                  ))}
                </ul>
                {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
                <div className="mt-3 flex items-center gap-3">
                  <Button size="sm" disabled={busy !== null} onClick={() => void instantiateTemplate(t.id)}>
                    {busy === t.id ? 'Creating…' : 'Use this bot'}
                  </Button>
                  <span className="text-xs text-muted-foreground">Creates a draft — connect your @BotFather token next.</span>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
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
          <h1 className="text-xl font-medium tracking-tight text-foreground">What do you want your bot to do?</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Describe it the way you would tell a person — “when someone starts the bot, show a
            welcome message with buttons for Menu, Order and Contact”. NURAE handles the technical
            part and you review everything before it goes live.
          </p>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={2000}
            rows={5}
            autoFocus
            placeholder="Create a bot for my clothing store. When someone starts it, welcome them and show buttons for Products, Order and Contact Us. When someone mentions a price, answer with our price list."
            className="mt-6 border-border bg-transparent text-sm"
          />
          {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
          <div className="mt-4 flex items-center gap-3">
            <Button size="sm" disabled={busy || !description.trim()} onClick={() => void createWithAI()}>
              {busy ? 'Building…' : 'Build it'}
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
        <h1 className="text-xl font-medium tracking-tight text-foreground">Start from scratch</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The manual path — name, prompt, token. You can leave the token empty; the bot saves as a
          draft until you connect Telegram. Behaviors can be added on the next screen.
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
        <Button size="sm" asChild className="mt-6 w-fit">
          <Link href="/">Sign in</Link>
        </Button>
      </main>
    </div>
  );
}
