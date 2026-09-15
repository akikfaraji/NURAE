'use client';

/**
 * NURAE — the USER dashboard (lives at /dashboard and at the user's vanity
 * route /<username>_<uid>/dashboard).
 *
 * The single morning view for a bot owner: are my bots running, what's in my
 * wallet, which bots lack instant-alert wiring, where are my customers — and
 * one-click lifecycle control per bot (Run / Stop / Restart).
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { SiteHeader, useSiteUser } from '@/components/nurae/site-shell';
import { StatusBadge } from '@/components/nurae/bits';
import { MyDashboardDTO, nuraeApi, ApiError } from '@/lib/nurae-client/api';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';

function usd(micros: number): string {
  const dollars = micros / 1_000_000;
  return `$${dollars.toFixed(dollars >= 10 || dollars === 0 ? 2 : 4)}`;
}

export function UserDashboardView({ slugOverride }: { slugOverride?: string }) {
  const router = useRouter();
  const { user, checked, signOut } = useSiteUser();
  const [data, setData] = useState<MyDashboardDTO | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (checked && !user) {
      // Not signed in — the landing page is the gate.
      router.replace('/');
    }
  }, [checked, user, router]);

  const load = useCallback(async () => {
    try {
      setData(await nuraeApi.myDashboard());
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : (err as Error).message);
    }
  }, []);

  useEffect(() => {
    if (user) void load();
  }, [user, load]);

  const lifecycle = async (id: string, action: 'start' | 'stop' | 'restart') => {
    setBusyId(id + action);
    try {
      if (action === 'start') await nuraeApi.startMyBot(id);
      else if (action === 'stop') await nuraeApi.stopMyBot(id);
      else await nuraeApi.restartMyBot(id);
      toast.success(action === 'stop' ? 'Bot stopped' : action === 'restart' ? 'Bot restarted' : 'Bot is starting');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `${action} failed`);
    } finally {
      setBusyId(null);
    }
  };

  if (!checked || !user || !data) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <p className="text-xs text-muted-foreground" role="status">{loadError ? loadError : 'Loading your dashboard…'}</p>
      </div>
    );
  }

  const vanity = slugOverride ?? data.slug;
  const running = data.bots.filter((b) => b.status === 'running').length;
  const unwired = data.bots.filter((b) => b.hasTelegramToken && !b.ownerChatId);
  const trialActive = data.wallet.trialEndsAt ? new Date(data.wallet.trialEndsAt) > new Date() : false;

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteHeader user={user} onSignOut={() => void signOut()} />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h1 className="text-xl font-semibold text-foreground sm:text-2xl">
              Welcome back, {data.user.name.split(' ')[0]}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Your dashboard lives at{' '}
              <Link href={`/${vanity}/dashboard`} className="font-mono text-xs text-foreground underline-offset-4 hover:underline">
                /{vanity}/dashboard
              </Link>
            </p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" asChild>
              <Link href="/chats/agents">Build a bot</Link>
            </Button>
            <Button size="sm" variant="outline" asChild>
              <Link href="/bots/new">New bot</Link>
            </Button>
          </div>
        </div>

        {/* Stats */}
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-md border border-border bg-background px-3 py-2.5">
            <p className="text-[11px] uppercase tracking-widest text-muted-foreground">Bots</p>
            <p className="mt-1 text-xl font-semibold tabular-nums text-foreground">{data.bots.length}</p>
          </div>
          <div className="rounded-md border border-border bg-background px-3 py-2.5">
            <p className="text-[11px] uppercase tracking-widest text-muted-foreground">Running</p>
            <p className="mt-1 text-xl font-semibold tabular-nums text-foreground">{running}</p>
          </div>
          <div className="rounded-md border border-border bg-background px-3 py-2.5">
            <p className="text-[11px] uppercase tracking-widest text-muted-foreground">Balance</p>
            <p className="mt-1 text-xl font-semibold tabular-nums text-foreground">{usd(data.wallet.balanceMicros)}</p>
          </div>
          <div className="rounded-md border border-border bg-background px-3 py-2.5">
            <p className="text-[11px] uppercase tracking-widest text-muted-foreground">Plan</p>
            <p className="mt-1 text-xl font-semibold text-foreground">
              {data.wallet.planId ? <span className="capitalize">{data.wallet.planId}</span> : trialActive ? 'Trial' : 'Free'}
            </p>
          </div>
        </div>

        {/* Alerts nudge */}
        {unwired.length > 0 && (
          <div className="mt-4 rounded-md border border-border bg-muted/40 px-3 py-2.5 text-sm">
            <p className="text-foreground">
              {unwired.length === 1 ? (
                <>
                  <span className="font-medium">{unwired[0].name}</span> doesn&apos;t push you updates yet.
                </>
              ) : (
                <span className="font-medium">{unwired.length} bots don&apos;t push you updates yet.</span>
              )}{' '}
              Wire your Telegram and every order or payment lands in your chat the second it happens.
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {unwired.map((b) => (
                <Button key={b.id} size="sm" variant="outline" asChild>
                  <Link href={`/bots/${b.id}`}>Wire {b.name}</Link>
                </Button>
              ))}
            </div>
          </div>
        )}

        {/* Bots */}
        <div className="mt-8">
          <h2 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">Your bots</h2>
          {data.bots.length === 0 ? (
            <div className="mt-3 rounded-md border border-dashed border-border px-4 py-10 text-center">
              <p className="text-sm text-muted-foreground">
                No bots yet. Describe what you want in the Agent and it builds one — menus, orders, payments, reminders.
              </p>
              <Button size="sm" asChild className="mt-3">
                <Link href="/chats/agents">Build your first bot</Link>
              </Button>
            </div>
          ) : (
            <div className="mt-3 space-y-2">
              {data.bots.map((b) => (
                <div key={b.id} className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-background px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Link href={`/bots/${b.id}`} className="truncate text-sm font-medium text-foreground hover:underline underline-offset-4">
                        {b.name}
                      </Link>
                      <StatusBadge status={b.status} />
                    </div>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {b.telegramUsername ? `${b.telegramUsername} · ` : ''}
                      {b.ownerChatId ? 'instant updates on' : 'instant updates off'}
                      {b.statusDetail ? ` · ${b.statusDetail}` : ''}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {b.status === 'running' ? (
                      <>
                        <Button variant="ghost" size="sm" disabled={busyId === b.id + 'stop'} onClick={() => void lifecycle(b.id, 'stop')}>
                          Stop
                        </Button>
                        <Button variant="ghost" size="sm" disabled={busyId === b.id + 'restart'} onClick={() => void lifecycle(b.id, 'restart')}>
                          Restart
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busyId === b.id + 'start' || !b.hasTelegramToken}
                        title={b.hasTelegramToken ? undefined : 'Add the Telegram token first'}
                        onClick={() => void lifecycle(b.id, 'start')}
                      >
                        Run
                      </Button>
                    )}
                    <Button variant="outline" size="sm" asChild>
                      <Link href={`/bots/${b.id}`}>Open</Link>
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recent agent sessions + quick links */}
        <div className="mt-8 grid gap-6 sm:grid-cols-2">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">Recent agent work</h2>
            {data.agentSessions.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">Nothing yet — the Agent is where you describe bots.</p>
            ) : (
              <ul className="mt-3 space-y-1.5">
                {data.agentSessions.map((s) => (
                  <li key={s.id}>
                    <Link href={`/chats/agents`} className="block truncate rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground hover:border-foreground/40">
                      {s.title}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">Shortcuts</h2>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Button variant="outline" size="sm" asChild>
                <Link href="/chats">Chats</Link>
              </Button>
              <Button variant="outline" size="sm" asChild>
                <Link href="/billing">Billing</Link>
              </Button>
              <Button variant="outline" size="sm" asChild>
                <Link href="/pricing">Pricing</Link>
              </Button>
              <Button variant="outline" size="sm" asChild>
                <Link href="/featured">Featured</Link>
              </Button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
