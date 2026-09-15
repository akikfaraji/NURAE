'use client';

/**
 * NURAE — the USER dashboard (lives at /dashboard and at the user's vanity
 * route /<username>_<uid>/dashboard).
 *
 * One job: the owner's morning view. What's running, what needs attention,
 * and the one primary action (describe a new bot). Numbers render as a quiet
 * typographic line — never as boxes — and only when there is something to
 * count. Secondary destinations live in the site nav, not in a shortcuts
 * grid that duplicates it.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { SiteHeader, useSiteUser } from '@/components/nurae/site-shell';
import { StatusBadge, StatLine } from '@/components/nurae/bits';
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
    if (!user) return;
    let alive = true;
    const kick = setTimeout(() => {
      if (alive) void load();
    }, 0);
    return () => {
      alive = false;
      clearTimeout(kick);
    };
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
  const plan = data.wallet.planId ? <span className="capitalize">{data.wallet.planId}</span> : trialActive ? 'Trial' : 'Free';

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteHeader user={user} onSignOut={() => void signOut()} />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h1 className="text-xl font-medium tracking-tight text-foreground sm:text-2xl">
            Welcome back, {data.user.name.split(' ')[0]}
          </h1>
          <Button size="sm" asChild>
            <Link href="/bots/new?ai=1">New bot</Link>
          </Button>
        </div>

        {data.bots.length > 0 ? (
          <>
            <StatLine
              className="mt-3"
              items={[
                { label: 'Bots', value: data.bots.length },
                { label: 'Running', value: running },
                { label: 'Balance', value: usd(data.wallet.balanceMicros) },
                { label: 'Plan', value: plan },
              ]}
            />

            {unwired.length > 0 && (
              <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
                {unwired.length === 1 ? (
                  <>
                    <Link href={`/bots/${unwired[0].id}`} className="text-foreground underline-offset-4 hover:underline">
                      {unwired[0].name}
                    </Link>{' '}
                    doesn&apos;t push you updates yet.
                  </>
                ) : (
                  <span>
                    {unwired.length} bots don&apos;t push you updates yet —{' '}
                    <Link href="/bots" className="text-foreground underline-offset-4 hover:underline">
                      wire your Telegram
                    </Link>{' '}
                    and every order or payment lands in your chat the second it happens.
                  </span>
                )}
              </p>
            )}

            <ul className="mt-8 border-t border-border/60">
              {data.bots.map((b) => (
                <li key={b.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border/60 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2.5">
                      <Link href={`/bots/${b.id}`} className="truncate text-sm font-medium text-foreground underline-offset-4 hover:underline">
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
                  </div>
                </li>
              ))}
            </ul>
          </>
        ) : (
          /* First run — one honest path, no empty stat boxes. */
          <div className="mt-8 max-w-xl">
            <p className="text-base leading-relaxed text-muted-foreground">
              Describe what you want — <span className="text-foreground">“a bot for my restaurant that takes orders”</span> —
              and the agent builds it: menus, buttons, payments, reminders. You approve before anything goes live.
            </p>
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <Button size="sm" asChild>
                <Link href="/bots/new?ai=1">Build your first bot</Link>
              </Button>
              <Link href="/bots/new" className="text-xs text-muted-foreground hover:text-foreground">
                or configure one manually
              </Link>
            </div>
          </div>
        )}

        {data.agentSessions.length > 0 && (
          <section className="mt-10">
            <h2 className="text-xs font-medium uppercase tracking-widest text-muted-foreground">Recent agent work</h2>
            <ul className="mt-3 border-t border-border/60">
              {data.agentSessions.map((s) => (
                <li key={s.id} className="border-b border-border/60">
                  <Link href="/chats/agents" className="block truncate py-2.5 text-sm text-foreground underline-offset-4 hover:underline">
                    {s.title}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* The vanity route is an address, not news — quiet, last, mono. */}
        <p className="mt-12 text-[11px] text-muted-foreground">
          Your dashboard also lives at{' '}
          <Link href={`/${vanity}/dashboard`} className="font-mono text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
            /{vanity}/dashboard
          </Link>
        </p>
      </main>
    </div>
  );
}
