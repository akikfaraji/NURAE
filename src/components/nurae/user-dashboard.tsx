'use client';

/**
 * NURAE — the USER dashboard (/dashboard and /<username>_<uid>/dashboard).
 *
 * V4 depth pass. This page is the product's return loop, and it answers three
 * questions in order, using only values the API actually returns:
 *
 *   1. what changed since you last looked (a bot in error with its real
 *      statusDetail, bots that cannot run without a Telegram token, trial
 *      days left, instant updates still off),
 *   2. where you stand (bots, running, balance, plan, and a setup ring built
 *      from three checks that are either true or false),
 *   3. the one thing worth doing next.
 *
 * Deliberately absent: any invented activity ("2 conversations while you were
 * away" requires evidence we do not have), any fake progress bar (the resume
 * strip stays out until the agent exposes real step counts), and any ring that
 * is not derived from a real number.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { SiteHeader, useSiteUser } from '@/components/nurae/site-shell';
import { LoadState, StatusBadge } from '@/components/nurae/bits';
import { DepthBackground, EventRow, Glass, Kicker, Metric, Ring } from '@/components/nurae/depth';
import { ApiKeysCard } from '@/components/nurae/api-keys-card';
import { AiHealthBanner } from '@/components/nurae/ai-health-banner';
import { MyDashboardDTO, nuraeApi, ApiError } from '@/lib/nurae-client/api';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';

function usd(micros: number): string {
  const dollars = micros / 1_000_000;
  return `$${dollars.toFixed(dollars >= 10 || dollars === 0 ? 2 : 4)}`;
}

function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.ceil(ms / 86_400_000));
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
      setLoadError(null);
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

  /**
   * Everything the return loop shows is derived here, once, from real fields:
   * no placeholder numbers, no optimistic counts.
   */
  const view = useMemo(() => {
    if (!data) return null;
    const bots = data.bots;
    const running = bots.filter((b) => b.status === 'running').length;
    const failing = bots.filter((b) => b.status === 'error');
    const missingToken = bots.filter((b) => !b.hasTelegramToken);
    const unwired = bots.filter((b) => b.hasTelegramToken && !b.ownerChatId);
    const trialDays = daysUntil(data.wallet.trialEndsAt);
    const trialActive = trialDays !== null && trialDays > 0;

    // Three checks that are unambiguously true or false for this account.
    const checks = {
      tokensReady: bots.length > 0 && missingToken.length === 0,
      updatesReady: bots.length > 0 && unwired.length === 0,
      planReady: Boolean(data.wallet.planId) || trialActive,
    };
    const done = Object.values(checks).filter(Boolean).length;

    return {
      bots,
      running,
      failing,
      missingToken,
      unwired,
      trialActive,
      trialDays,
      done,
      checks,
      balance: data.wallet.balanceMicros,
      plan: data.wallet.planId ? data.wallet.planId : trialActive ? 'Trial' : 'Free',
    };
  }, [data]);

  if (!checked || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <p className="text-xs text-muted-foreground" role="status">Loading your dashboard…</p>
      </div>
    );
  }

  // A failed load is a STATE, not a forever-"Loading…".
  if (!data || !view) {
    return (
      <div className="relative flex min-h-screen flex-col bg-background">
        <SiteHeader user={user} onSignOut={() => void signOut()} />
        <main className="relative z-10 mx-auto w-full max-w-md flex-1 px-4 py-16 sm:px-6">
          <LoadState
            loading={!loadError}
            error={loadError}
            onRetry={() => void load()}
            isEmpty={false}
            loadingLabel="Loading your dashboard…"
          >
            {null}
          </LoadState>
        </main>
      </div>
    );
  }

  const vanity = slugOverride ?? data.slug;
  const first = data.user.name.split(' ')[0];
  const nextAction = (() => {
    if (view.bots.length === 0) {
      return { title: 'Build your first bot', body: 'Describe it in a sentence. The agent writes the configuration and waits for your approval.', href: '/bots/new?ai=1', cta: 'Start building' };
    }
    if (view.missingToken.length > 0) {
      const bot = view.missingToken[0];
      return { title: `Add the Telegram token for ${bot.name}`, body: 'Without it the bot cannot register with Telegram, so nothing it knows can reach a customer.', href: `/bots/${bot.id}`, cta: 'Add the token' };
    }
    if (view.unwired.length > 0) {
      const bot = view.unwired[0];
      return { title: `Wire your Telegram for ${bot.name}`, body: 'Orders and payments then land in your chat the second they happen, instead of waiting for you to look.', href: `/bots/${bot.id}`, cta: 'Wire updates' };
    }
    return null;
  })();

  return (
    <div className="relative flex min-h-screen flex-col">
      <DepthBackground />
      <SiteHeader user={user} onSignOut={() => void signOut()} />
      <main className="relative z-10 mx-auto w-full max-w-5xl flex-1 px-4 py-7 sm:px-6">
        <div className="n-stagger">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <div>
              <h1 className="text-xl font-medium tracking-tight text-foreground sm:text-2xl">
                Welcome back, {first}
              </h1>
              <p className="mt-1 text-[12px] text-muted-foreground">
                {view.failing.length > 0
                  ? `${view.failing.length} bot${view.failing.length === 1 ? '' : 's'} need attention. Everything else is quiet.`
                  : view.bots.length > 0
                    ? 'Nothing needs attention. Here is where things stand.'
                    : 'Your account is ready. The first step is one sentence long.'}
              </p>
            </div>
            <Button size="sm" asChild>
              <Link href="/bots/new?ai=1">New bot</Link>
            </Button>
          </div>

          {/* Silent when the platform AI key works; loud when agents cannot call their provider. */}
          <div className="mt-4">
            <AiHealthBanner />
          </div>

          {view.bots.length > 0 ? (
            <>
              {/* Where you stand: one glass strip, four metrics, mono numerals. */}
              <Glass className="mt-4 grid grid-cols-2 gap-y-4 py-3 sm:grid-cols-4">
                <Metric label="Bots" value={view.bots.length} />
                <Metric label="Running" value={view.running} sub={`${view.bots.length - view.running} stopped`} />
                <Metric label="Balance" value={usd(view.balance)} />
                <Metric label="Plan" value={<span className="capitalize">{view.plan}</span>} />
              </Glass>

              <div className="mt-3 grid gap-3 lg:grid-cols-[1.35fr_1fr]">
                {/* What changed: real states only, each with its real reason. */}
                <Glass>
                  <div className="mb-1 flex items-baseline justify-between gap-3">
                    <Kicker className="mb-0">Since your last check</Kicker>
                    <span className="n-num text-[10.5px] text-muted-foreground/70">
                      {view.bots.length} bot{view.bots.length === 1 ? '' : 's'} tracked
                    </span>
                  </div>
                  {view.failing.length === 0 && view.missingToken.length === 0 && view.unwired.length === 0 && !view.trialActive ? (
                    <EventRow mark="ok" when="now">
                      Nothing needs attention. Every bot has its credentials and every update is wired.
                    </EventRow>
                  ) : (
                    <>
                      {view.failing.slice(0, 2).map((b) => (
                        <EventRow key={b.id} mark="!" when={b.status}>
                          <Link href={`/bots/${b.id}`} className="font-medium text-foreground underline-offset-4 hover:underline">
                            {b.name}
                          </Link>{' '}
                          {b.statusDetail ? b.statusDetail : 'stopped with an error the platform recorded.'}
                        </EventRow>
                      ))}
                      {view.missingToken.length > 0 && (
                        <EventRow mark="·" when={`${view.missingToken.length}`}>
                          {view.missingToken.length} bot{view.missingToken.length === 1 ? '' : 's'} cannot run yet: no Telegram token.
                        </EventRow>
                      )}
                      {view.unwired.length > 0 && (
                        <EventRow mark="·" when={`${view.unwired.length}`}>
                          Instant updates are off for {view.unwired.length} bot{view.unwired.length === 1 ? '' : 's'}. Orders and payments will not be pushed to you.
                        </EventRow>
                      )}
                      {view.trialActive && view.trialDays !== null && (
                        <EventRow mark="·" when={`${view.trialDays}d`}>
                          Free week active: {view.trialDays} day{view.trialDays === 1 ? '' : 's'} left. Hosting and AI are included until it ends.
                        </EventRow>
                      )}
                    </>
                  )}
                </Glass>

                {/* Setup ring: three checks, each one a fact about this account. */}
                <Glass>
                  <Kicker>Setup</Kicker>
                  <Ring
                    pct={(view.done / 3) * 100}
                    center={`${view.done}/3`}
                    label="Complete"
                    sub={
                      <span className="block space-y-0.5">
                        <span className="block">{view.checks.tokensReady ? 'Credentials added' : 'Credentials missing'}</span>
                        <span className="block">{view.checks.updatesReady ? 'Updates wired' : 'Updates off'}</span>
                        <span className="block">{view.checks.planReady ? 'Plan or trial active' : 'No plan yet'}</span>
                      </span>
                    }
                  />
                </Glass>
              </div>

              {/* The one thing worth doing next. Omitted entirely when nothing is wrong. */}
              {nextAction && (
                <Glass className="mt-3 flex flex-wrap items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="m-0 text-[12.5px] font-medium text-foreground">{nextAction.title}</p>
                    <p className="m-0 mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">{nextAction.body}</p>
                  </div>
                  <Button size="sm" asChild>
                    <Link href={nextAction.href}>{nextAction.cta}</Link>
                  </Button>
                </Glass>
              )}

              {/* The fleet, as rows. Actions stay put; the row never becomes a card. */}
              <section className="mt-6">
                <div className="flex items-baseline justify-between">
                  <Kicker className="mb-0">Your bots</Kicker>
                  <Link href="/bots" className="n-press rounded text-[11.5px] text-muted-foreground hover:text-foreground">
                    Manage all
                  </Link>
                </div>
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full min-w-[560px] border-collapse">
                    <thead>
                      <tr>
                        {['Bot', 'Status', 'Updates', 'Credentials', ''].map((h, i) => (
                          <th
                            key={h || i}
                            scope="col"
                            className={
                              'h-8 border-b border-[color:var(--depth-line)] text-left align-middle ' +
                              (i >= 3 ? 'text-right' : '')
                            }
                          >
                            <span className="n-kicker">{h}</span>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {view.bots.map((b) => (
                        <tr key={b.id} className="border-b border-[color:var(--depth-line-soft)]">
                          <td className="h-9 pr-3 align-middle">
                            <Link
                              href={`/bots/${b.id}`}
                              className="truncate text-[13px] font-medium text-foreground underline-offset-4 hover:underline"
                            >
                              {b.name}
                            </Link>
                            <span className="ml-2 font-mono text-[11px] text-muted-foreground">
                              {b.telegramUsername ?? 'no username yet'}
                            </span>
                          </td>
                          <td className="h-9 pr-3 align-middle">
                            <StatusBadge status={b.status} />
                          </td>
                          <td className="h-9 pr-3 align-middle">
                            <span className="n-num text-[12px] text-muted-foreground">
                              {b.ownerChatId ? 'wired' : 'off'}
                            </span>
                          </td>
                          <td className="h-9 pr-3 align-middle text-right">
                            <span className="n-num text-[11px] text-muted-foreground">
                              {b.hasTelegramToken ? 'set' : 'missing'}
                            </span>
                          </td>
                          <td className="h-9 align-middle">
                            <div className="flex items-center justify-end gap-1">
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
                                <span
                                  className="inline-flex items-center gap-2"
                                  title={b.hasTelegramToken ? undefined : 'Add the Telegram token first, on the bot page'}
                                >
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={busyId === b.id + 'start' || !b.hasTelegramToken}
                                    onClick={() => void lifecycle(b.id, 'start')}
                                  >
                                    Run
                                  </Button>
                                  {!b.hasTelegramToken && (
                                    <span className="text-[11px] text-muted-foreground">missing</span>
                                  )}
                                </span>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          ) : (
            /* First run: one honest path, and no empty stat boxes. */
            <Glass className="mt-4 max-w-xl">
              <Kicker>First step</Kicker>
              <p className="m-0 text-base leading-relaxed text-muted-foreground">
                Describe what you want —{' '}
                <span className="text-foreground">&quot;a bot for my restaurant that takes orders&quot;</span> — and the
                agent builds it: menus, buttons, payments, reminders. You approve before anything goes live.
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Button size="sm" asChild>
                  <Link href="/bots/new?ai=1">Build your first bot</Link>
                </Button>
                <Link href="/bots/new" className="text-xs text-muted-foreground hover:text-foreground">
                  or configure one manually
                </Link>
              </div>
            </Glass>
          )}

          {data.agentSessions.length > 0 && (
            <section className="mt-6">
              <Kicker>Recent agent work</Kicker>
              <Glass bleed className="mt-2 py-1">
                <ul className="m-0 list-none p-0">
                  {data.agentSessions.map((s) => (
                    <li key={s.id} className="border-b border-[color:var(--depth-line-soft)] last:border-b-0">
                      <Link
                        href="/chats/agents"
                        className="n-press block truncate px-4 py-2.5 text-[13px] text-foreground hover:bg-white/5"
                      >
                        {s.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              </Glass>
            </section>
          )}

          {/* External AI agents operate NURAE with these Bearer keys. */}
          <ApiKeysCard />

          {/* The vanity route is an address, not news: quiet, last, mono. */}
          <p className="mt-10 text-[11px] text-muted-foreground">
            Your dashboard also lives at{' '}
            <Link
              href={`/${vanity}/dashboard`}
              className="font-mono text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              /{vanity}/dashboard
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}
