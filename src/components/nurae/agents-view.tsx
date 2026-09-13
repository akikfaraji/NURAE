'use client';

/**
 * NURAE — /chats/agents: where NURAE agents DO work.
 *
 * Not another chatbot page: each agent session is a workspace thread with
 * durable task state. The Bot Builder agent is the first real agent; the
 * registry grows only when new agents actually ship (no fake placeholders).
 *
 * The activity feed shows tool work as understandable progress
 * (✓ Created bot …) — sourced from the AgentStep audit trail, not logs.
 * Consequential actions (publish) wait for an explicit user approval.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { SiteHeader, SiteSplash, useSiteUser } from '@/components/nurae/site-shell';
import { Markdown } from '@/components/nurae/markdown';
import { ActivityStepDTO, ApiError, EntryDTO, SessionDTO, nuraeApi } from '@/lib/nurae-client/api';
import { Button } from '@/components/ui/button';

export function AgentsView() {
  const { user, checked, signOut } = useSiteUser();
  const router = useRouter();
  const params = useSearchParams();
  const sessionParam = params.get('session');
  const taskParam = params.get('task');

  const [sessions, setSessions] = useState<SessionDTO[]>([]);
  const [activeId, setActiveId] = useState<string | null>(sessionParam);
  const [entries, setEntries] = useState<EntryDTO[]>([]);
  const [pendingSteps, setPendingSteps] = useState<ActivityStepDTO[]>([]);
  const [needsConfirm, setNeedsConfirm] = useState(false);
  const [draftBotId, setDraftBotId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const bottomRef = useRef<HTMLDivElement | null>(null);
  const taskSentRef = useRef(false);

  const refreshSessions = useCallback(async () => {
    try {
      const r = await nuraeApi.listAgentSessions();
      setSessions(r.sessions);
    } catch {
      /* quiet */
    }
  }, []);

  useEffect(() => {
    (async () => {
      if (user) await refreshSessions();
    })();
  }, [user, refreshSessions]);

  const loadSession = useCallback(async (id: string) => {
    setError(null);
    try {
      const r = await nuraeApi.getSession(id);
      if (r.session.kind !== 'agent') {
        router.replace(`/chats?c=${id}`);
        return;
      }
      setEntries(r.entries);
      const lastAssistant = [...r.entries].reverse().find((e) => e.role === 'assistant');
      setNeedsConfirm(Boolean(lastAssistant?.needsConfirm));
      setDraftBotId(lastAssistant?.draftBotId ?? null);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 404 ? 'This agent session does not exist.' : (e as Error).message);
    }
  }, [router]);

  useEffect(() => {
    (async () => {
      if (!user || !activeId) {
        setEntries([]);
        return;
      }
      await loadSession(activeId);
    })();
  }, [user, activeId, loadSession]);

  const scrollDown = useCallback((smooth = true) => {
    requestAnimationFrame(() =>
      bottomRef.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'end' }),
    );
  }, []);

  useEffect(() => {
    scrollDown(!busy);
  }, [entries, pendingSteps, busy, scrollDown]);

  const createAndRun = async (task: string) => {
    setBusy(true);
    setError(null);
    try {
      const { session } = await nuraeApi.createAgentSession(task.slice(0, 60) || 'Bot build');
      setActiveId(session.id);
      setEntries([]);
      router.replace(`/chats/agents?session=${session.id}`);
      await runTurn(session.id, task, false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the agent.');
      setBusy(false);
    }
  };

  const runTurn = async (sessionId: string, text: string, approve: boolean) => {
    setBusy(true);
    setError(null);
    setPendingSteps([]);
    try {
      const r = await nuraeApi.sendAgentMessage(sessionId, text, approve);
      // Show the activity feed with a small stagger for readability.
      for (const step of r.activity) {
        setPendingSteps((s) => [...s, step]);
        await new Promise((res) => setTimeout(res, 260));
      }
      setEntries((e) => [
        ...e,
        ...(text
          ? [{
              id: `local-${Date.now()}`,
              role: 'user',
              content: text,
              attachments: [],
              activity: [],
              needsConfirm: false,
              draftBotId: null,
              handoff: null,
              createdAt: new Date().toISOString(),
            } satisfies EntryDTO]
          : []),
        {
          id: `assistant-${Date.now()}`,
          role: 'assistant',
          content: r.reply,
          attachments: [],
          activity: r.activity,
          needsConfirm: r.needsConfirm,
          draftBotId: r.draftBotId,
          handoff: null,
          createdAt: new Date().toISOString(),
        },
      ]);
      setPendingSteps([]);
      setNeedsConfirm(r.needsConfirm);
      setDraftBotId(r.draftBotId);
      void refreshSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The agent could not continue.');
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || busy || !activeId) return;
    setDraft('');
    await runTurn(activeId, text, false);
  };

  // Deep link from the chat handoff: ?session=<new>&task=<text>
  useEffect(() => {
    if (!user || taskSentRef.current) return;
    const task = taskParam?.trim();
    if (!task) return;
    taskSentRef.current = true;
    (async () => {
      if (sessionParam) {
        // Session pre-seeded server-side: run the first turn with the task.
        setActiveId(sessionParam);
        await runTurn(sessionParam, task, false);
      } else {
        await createAndRun(task);
      }
    })();
  }, [user, taskParam, sessionParam]);

  if (!checked) return <SiteSplash />;

  if (!user) {
    return (
      <div className="flex min-h-screen flex-col bg-background">
        <SiteHeader variant="public" user={null} />
        <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-16">
          <h1 className="text-lg font-medium text-foreground">Sign in to use agents</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Agents build real things for you — they run inside your account.
          </p>
          <Link href="/" className="mt-6 inline-flex w-fit">
            <Button size="sm">Sign in</Button>
          </Link>
        </main>
      </div>
    );
  }

  return (
    <div className="flex h-dvh flex-col bg-background">
      <SiteHeader user={user} onSignOut={signOut} />

      <div className="flex min-h-0 flex-1">
        {/* Sessions */}
        <aside className="hidden w-64 shrink-0 flex-col border-r border-border/60 md:flex">
          <div className="p-3">
            <button
              type="button"
              onClick={() => {
                setActiveId(null);
                router.push('/chats/agents');
              }}
              className="w-full border border-border px-3 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-muted/60"
            >
              + New build
            </button>
          </div>
          <nav className="min-h-0 flex-1 overflow-y-auto pb-4" aria-label="Agent sessions">
            {!sessions.length && (
              <p className="px-4 py-3 text-[11px] leading-relaxed text-muted-foreground">
                No builds yet. Describe what to build and the agent does the work.
              </p>
            )}
            {sessions.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => {
                  setActiveId(s.id);
                  setDrawerOpen(false);
                  router.push(`/chats/agents?session=${s.id}`);
                }}
                className={
                  'block w-full px-3 py-2 text-left ' +
                  (s.id === activeId ? 'bg-muted/70' : 'hover:bg-muted/40')
                }
              >
                <span className="block truncate text-xs text-foreground">{s.title}</span>
                <span className="block text-[10px] uppercase tracking-widest text-muted-foreground/70">
                  {s.agent ?? 'agent'}
                </span>
              </button>
            ))}
          </nav>
        </aside>

        {/* Main */}
        <main className="flex min-w-0 flex-1 flex-col">
          {drawerOpen && (
            <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true">
              <div className="absolute inset-0 bg-black/60" onClick={() => setDrawerOpen(false)} />
              <div className="absolute inset-y-0 left-0 w-72 border-r border-border bg-background p-3">
                <button
                  type="button"
                  onClick={() => {
                    setActiveId(null);
                    setDrawerOpen(false);
                    router.push('/chats/agents');
                  }}
                  className="mb-2 w-full border border-border px-3 py-1.5 text-left text-xs"
                >
                  + New build
                </button>
                {sessions.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => {
                      setActiveId(s.id);
                      setDrawerOpen(false);
                      router.push(`/chats/agents?session=${s.id}`);
                    }}
                    className={'block w-full px-2 py-2 text-left text-xs ' + (s.id === activeId ? 'bg-muted/70' : '')}
                  >
                    {s.title}
                  </button>
                ))}
              </div>
            </div>
          )}

          {!activeId ? (
            <div className="flex flex-1 flex-col items-center justify-center px-6 pb-24">
              <h1 className="text-lg font-medium text-foreground">Bot Builder</h1>
              <p className="mt-2 max-w-sm text-center text-sm leading-relaxed text-muted-foreground">
                Describe the Telegram bot you want. The agent creates the configuration,
                adds commands and buttons, attaches knowledge from your files — and asks
                before anything goes live.
              </p>
              <Link href="/bots/new?ai=1" className="mt-6 inline-flex">
                <Button size="sm" variant="outline">Describe a bot →</Button>
              </Link>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between border-b border-border/60 px-4 py-2 sm:px-6">
                <button
                  type="button"
                  onClick={() => setDrawerOpen(true)}
                  className="text-xs text-muted-foreground hover:text-foreground md:hidden"
                >
                  ☰ Builds
                </button>
                <span className="truncate text-xs uppercase tracking-widest text-muted-foreground">
                  Bot Builder agent
                </span>
                {draftBotId && (
                  <Link href={`/bots/${draftBotId}`} className="text-xs text-foreground underline-offset-4 hover:underline">
                    Open bot →
                  </Link>
                )}
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto">
                <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6 sm:px-6">
                  {entries.map((m) => (
                    <AgentMessage key={m.id} entry={m} />
                  ))}
                  {busy && (
                    <p className="text-xs text-muted-foreground" aria-label="Agent is working">
                      <span className="animate-pulse">●</span> working…
                    </p>
                  )}
                  {pendingSteps.length > 0 && <Activity steps={pendingSteps} live />}
                  {error && (
                    <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
                      {error}
                    </div>
                  )}
                  <div ref={bottomRef} />
                </div>
              </div>

              {/* Composer + approval */}
              <div className="shrink-0 border-t border-border/60">
                <div className="mx-auto w-full max-w-3xl px-4 py-3 sm:px-6">
                  {needsConfirm && (
                    <div className="mb-2 flex flex-wrap items-center gap-3 border border-border bg-muted/40 px-3 py-2">
                      <p className="text-xs text-muted-foreground">
                        The agent is waiting for your approval to make the bot live.
                      </p>
                      <div className="ml-auto flex gap-2">
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() => void runTurn(activeId, '', true)}
                        >
                          Approve &amp; publish
                        </Button>
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => setNeedsConfirm(false)}>
                          Not yet
                        </Button>
                      </div>
                    </div>
                  )}
                  <div className="flex items-end gap-2">
                    <textarea
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          void send();
                        }
                      }}
                      rows={1}
                      maxLength={8000}
                      placeholder="Tell the agent what to build or change…"
                      className="max-h-40 min-h-9 flex-1 resize-none border border-border bg-transparent px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/40"
                      onInput={(e) => {
                        const el = e.currentTarget;
                        el.style.height = 'auto';
                        el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => void send()}
                      disabled={busy || !draft.trim()}
                      className="flex h-9 shrink-0 items-center border border-border px-3 text-xs text-foreground hover:bg-muted/60 disabled:opacity-40"
                    >
                      {busy ? '…' : 'Send'}
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

function AgentMessage({ entry }: { entry: EntryDTO }) {
  if (entry.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap bg-muted/70 px-3.5 py-2 text-sm leading-relaxed text-foreground">
          {entry.content}
        </div>
      </div>
    );
  }
  if (entry.role === 'system') {
    return (
      <p className="border-l-2 border-border pl-3 text-xs italic leading-relaxed text-muted-foreground">
        {entry.content}
      </p>
    );
  }
  return (
    <div className="space-y-3">
      {entry.activity.length > 0 && <Activity steps={entry.activity} />}
      {entry.content ? <Markdown>{entry.content}</Markdown> : null}
    </div>
  );
}

/** Understandable progress — subtle, sourced from the audit trail. */
function Activity({ steps, live }: { steps: ActivityStepDTO[]; live?: boolean }) {
  return (
    <ul className="space-y-1 border-l border-border/70 pl-3" aria-live={live ? 'polite' : undefined}>
      {steps.map((s) => (
        <li key={s.seq} className="flex items-baseline gap-2 text-xs">
          <span
            className={
              s.status === 'ok'
                ? 'text-foreground'
                : s.status === 'error'
                  ? 'text-destructive'
                  : 'animate-pulse text-muted-foreground'
            }
            aria-hidden
          >
            {s.status === 'ok' ? '✓' : s.status === 'error' ? '×' : '…'}
          </span>
          <span className={s.status === 'error' ? 'text-destructive' : 'text-muted-foreground'}>
            {s.label}
          </span>
        </li>
      ))}
    </ul>
  );
}
