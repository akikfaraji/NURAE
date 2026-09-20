'use client';

/**
 * NURAE — /chats/agents: where NURAE agents DO work.
 *
 * The agent workspace mirrors the chat workflow one-to-one (same sidebar
 * actions, same attachments, same optimistic sends, same Enter/Shift+Enter
 * composer) — the only difference is that turns here DO work through the
 * audited tool layer and show a live activity feed.
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
import { AgentActivity } from '@/components/nurae/agent-activity';
import { PageFade } from '@/components/nurae/bits';
import { SessionList } from '@/components/nurae/session-list';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { ActivityStepDTO, ApiError, EntryDTO, FileDTO, SessionDTO, nuraeApi } from '@/lib/nurae-client/api';
import { Button } from '@/components/ui/button';

const ACCEPTED_FILES = '.pdf,.md,.markdown,.txt,.csv,.docx,.json,.log,.png,.jpg,.jpeg,.gif,.webp,.svg';

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
  const [attachments, setAttachments] = useState<FileDTO[]>([]);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const bottomRef = useRef<HTMLDivElement | null>(null);
  const taskSentRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const autoOpenedRef = useRef<string | null>(null);

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

  // Landing on /chats/agents with no build selected opens the most recent one —
  // the empty state is for first-time users (or an explicit "+ New build").
  // Skipped when a ?task= deep link is about to start a fresh build.
  useEffect(() => {
    if (!user || taskParam || activeId || !sessions.length) return;
    if (autoOpenedRef.current === user.id) return;
    autoOpenedRef.current = user.id;
    setActiveId(sessions[0].id);
    router.replace(`/chats/agents?session=${sessions[0].id}`);
  }, [user, taskParam, activeId, sessions, router]);

  const loadSession = useCallback(async (id: string) => {
    setError(null);
    try {
      const r = await nuraeApi.getSession(id);
      if (r.session.kind !== 'agent') {
        router.replace(`/chats?c=${id}`);
        return;
      }
      setEntries(r.entries);
      setAttachments([]);
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

  const openSession = (id: string | null) => {
    setDrawerOpen(false);
    router.push(id ? `/chats/agents?session=${id}` : '/chats/agents');
  };

  const renameSession = async (id: string, title: string) => {
    setSessions((s) => s.map((x) => (x.id === id ? { ...x, title } : x)));
    await nuraeApi.patchSession(id, { title }).catch(() => undefined);
  };

  const deleteSession = async (id: string) => {
    setSessions((s) => s.filter((x) => x.id !== id));
    if (id === activeId) openSession(null);
    await nuraeApi.deleteSession(id).catch(() => undefined);
  };

  const archiveSession = async (id: string) => {
    setSessions((s) => s.filter((x) => x.id !== id));
    if (id === activeId) openSession(null);
    await nuraeApi.patchSession(id, { status: 'archived' }).catch(() => undefined);
  };

  /** Optimistic user entry — skipped when the same task is already on screen
   *  (e.g. the handoff already persisted it server-side). Returns the local id
   *  so the caller can remove EXACTLY this entry on failure (BR-034: two
   *  independent Date.now() ids could mismatch, leaving a ghost bubble that
   *  made the agent look like it received the task and ignored it). */
  const optimisticUser = (text: string): string => {
    const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setEntries((e) => {
      const last = e[e.length - 1];
      if (last && last.role === 'user' && last.content === text) return e;
      return [
        ...e,
        {
          id: localId,
          role: 'user',
          content: text,
          attachments: attachments.map((a) => ({ fileId: a.id, name: a.name, kind: a.kind })),
          activity: [],
          needsConfirm: false,
          draftBotId: null,
          handoff: null,
          createdAt: new Date().toISOString(),
        } satisfies EntryDTO,
      ];
    });
    return localId;
  };

  const runTurn = async (sessionId: string, text: string, approve: boolean, attachmentIds?: string[]) => {
    setBusy(true);
    setError(null);
    setPendingSteps([]);
    let localId: string | null = null;
    if (text || (attachmentIds ?? []).length) {
      localId = optimisticUser(text);
      setAttachments([]);
    }
    try {
      const r = await nuraeApi.sendAgentMessage(sessionId, text, approve, attachmentIds);
      // Show the activity feed with a small stagger for readability.
      for (const step of r.activity) {
        setPendingSteps((s) => [...s, step]);
        await new Promise((res) => setTimeout(res, 260));
      }
      setEntries((e) => [
        ...e,
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
        } satisfies EntryDTO,
      ]);
      setPendingSteps([]);
      setNeedsConfirm(r.needsConfirm);
      setDraftBotId(r.draftBotId);
      void refreshSessions();
    } catch (err) {
      // The optimistic user entry was never persisted — remove it (same rule
      // as chat) and surface the error.
      if (localId) setEntries((e) => e.filter((x) => x.id !== localId));
      setError(err instanceof Error ? err.message : 'The agent could not continue.');
    } finally {
      setBusy(false);
      textareaRef.current?.focus();
    }
  };

  const createAndRun = async (task: string) => {
    setBusy(true);
    setError(null);
    try {
      const { session } = await nuraeApi.createAgentSession(task.slice(0, 60) || 'Bot build');
      setActiveId(session.id);
      setEntries([]);
      router.replace(`/chats/agents?session=${session.id}`);
      // The sidebar must show the new build even when the first turn fails.
      void refreshSessions();
      await runTurn(session.id, task, false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the agent.');
      setBusy(false);
    }
  };

  const send = async () => {
    const text = draft.trim();
    if ((!text && attachments.length === 0) || busy || !activeId) return;
    const attachmentIds = attachments.map((a) => a.id);
    setDraft('');
    await runTurn(activeId, text, false, attachmentIds.length ? attachmentIds : undefined);
  };

  // Deep link from the chat handoff or the bot form: ?session=<id> — the
  // server already ran the first turn before navigating here, so just load it.
  // ?task=<text> without a session starts a fresh build with that task.
  useEffect(() => {
    if (!user || taskSentRef.current) return;
    const task = taskParam?.trim();
    if (!task) return;
    taskSentRef.current = true;
    (async () => {
      if (sessionParam) {
        // Server already ran turn 1 — open the session.
        setActiveId(sessionParam);
      } else {
        await createAndRun(task);
      }
    })();
  }, [user, taskParam, sessionParam]);

  const uploadFiles = async (files: FileList | null) => {
    if (!files?.length || !activeId) return;
    setUploading(true);
    setError(null);
    try {
      for (const file of Array.from(files).slice(0, 5)) {
        const r = await nuraeApi.uploadFile(file, activeId);
        setAttachments((a) => [...a, r.file]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // One composer for both states: an open build appends to it; the empty
  // state starts the build with the first message.
  const composer = (
    <div className="flex items-end gap-2">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={ACCEPTED_FILES}
        className="hidden"
        onChange={(e) => void uploadFiles(e.target.files)}
      />
      <button
        type="button"
        aria-label="Attach files"
        title={activeId ? 'Attach files (price lists, menus, docs…)' : 'Send your first message to attach files'}
        onClick={() => fileInputRef.current?.click()}
        disabled={!activeId || uploading}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
      >
        {uploading ? <span className="animate-pulse">…</span> : '+'}
      </button>
      <textarea
        ref={textareaRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (activeId) void send();
            else {
              const text = draft.trim();
              if (text && !busy) void createAndRun(text);
            }
          }
        }}
        rows={1}
        maxLength={8000}
        placeholder="Tell the agent what to build or change…"
        className="max-h-40 min-h-9 flex-1 resize-none rounded-md border border-border bg-transparent px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
        onInput={(e) => {
          const el = e.currentTarget;
          el.style.height = 'auto';
          el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
        }}
      />
      <button
        type="button"
        onClick={() => {
          if (activeId) void send();
          else {
            const text = draft.trim();
            if (text && !busy) void createAndRun(text);
          }
        }}
        disabled={busy || (!draft.trim() && attachments.length === 0)}
        className="flex h-9 shrink-0 items-center rounded-md border border-border px-3 text-xs text-foreground hover:bg-muted/60 disabled:opacity-40"
      >
        {busy ? '…' : 'Send'}
      </button>
    </div>
  );

  const attachmentChips = attachments.length > 0 && (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {attachments.map((a) => (
        <span key={a.id} className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
          {a.name}
          <button
            type="button"
            aria-label={`Remove ${a.name}`}
            onClick={() => setAttachments((x) => x.filter((y) => y.id !== a.id))}
            className="hover:text-foreground"
          >
            ×
          </button>
        </span>
      ))}
    </div>
  );

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
          <Button size="sm" asChild className="mt-6 w-fit">
            <Link href="/">Sign in</Link>
          </Button>
        </main>
      </div>
    );
  }

  return (
    <div className="flex h-dvh flex-col bg-background">
      <SiteHeader user={user} onSignOut={signOut} hideMobileMenu />

      <PageFade className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1">
        {/* Sessions */}
        <aside className="hidden w-64 shrink-0 flex-col border-r border-border/60 md:flex">
          <div className="p-3">
            <button
              type="button"
              onClick={() => openSession(null)}
              className="w-full rounded-md border border-border px-3 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-muted/60"
            >
              + New build
            </button>
          </div>
          <SessionList
            sessions={sessions}
            activeId={activeId}
            emptyText="No builds yet. Describe what to build and the agent does the work."
            onOpen={(id) => { setActiveId(id); openSession(id); }}
            onRename={renameSession}
            onDelete={deleteSession}
            onArchive={archiveSession}
          />
        </aside>

        {/* Main */}
        <main className="flex min-w-0 flex-1 flex-col">
          {/* Mobile sessions drawer — Sheet (slide, focus trap, Esc, scroll lock). */}
          <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
            <SheetContent
              side="left"
              className="flex w-72 flex-col border-border bg-background p-0 md:hidden [&>button]:hidden"
            >
              <SheetTitle className="flex items-center justify-between px-3 pt-3 text-xs uppercase tracking-widest text-muted-foreground">
                Builds
              </SheetTitle>
              <div className="px-3 pb-3 pt-3">
                <button
                  type="button"
                  onClick={() => openSession(null)}
                  className="flex min-h-11 w-full items-center rounded-md border border-border px-3 text-left text-xs text-foreground transition-colors hover:bg-muted/60"
                >
                  + New build
                </button>
              </div>
              <SessionList
                sessions={sessions}
                activeId={activeId}
                emptyText="No builds yet."
                onOpen={(id) => { setActiveId(id); openSession(id); }}
                onRename={renameSession}
                onDelete={deleteSession}
                onArchive={archiveSession}
              />
              <nav className="mt-auto flex flex-wrap gap-x-4 gap-y-1.5 border-t border-border/60 p-3" aria-label="Site">
                {[
                  { href: '/chats', label: 'Chats' },
                  { href: '/bots', label: 'Bots' },
                  { href: '/featured', label: 'Featured' },
                  { href: '/billing', label: 'Billing' },
                  { href: '/help', label: 'Help' },
                ].map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setDrawerOpen(false)}
                    className="min-h-11 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {item.label}
                  </Link>
                ))}
              </nav>
            </SheetContent>
          </Sheet>

          {/* One slim top bar, shared by the empty state and open builds — the
              drawer trigger inside it is the ONLY menu button on phones. */}
          <div className="flex items-center justify-between border-b border-border/60 px-4 py-2 sm:px-6">
            <button
              type="button"
              aria-label="Open builds"
              onClick={() => setDrawerOpen(true)}
              className="-ml-1 flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground md:hidden"
            >
              <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden>
                <path d="M1 3.5h14M1 8h14M1 12.5h14" stroke="currentColor" strokeWidth="1.2" />
              </svg>
            </button>
            <span className="truncate text-xs uppercase tracking-widest text-muted-foreground">
              Bot Builder agent
            </span>
            {draftBotId ? (
              <Link href={`/bots/${draftBotId}`} className="text-xs text-foreground underline-offset-4 hover:underline">
                Open bot →
              </Link>
            ) : (
              <span className="w-px" aria-hidden />
            )}
          </div>

          {!activeId ? (
            <>
              <EmptyAgent
                userName={user.name}
                busy={busy}
                onPick={(text) => void createAndRun(text)}
              />
              <div className="shrink-0 border-t border-border/60">
                <div className="mx-auto w-full max-w-3xl px-4 py-3 sm:px-6">
                  {attachmentChips}
                  {composer}
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="min-h-0 flex-1 overflow-y-auto">
                <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6 sm:px-6">
                  {entries.map((m) => (
                    <AgentMessage key={m.id} entry={m} />
                  ))}
                  {busy && (
                    <p className="text-xs text-muted-foreground" aria-label="Agent is working" role="status" aria-live="polite">
                      <span className="animate-pulse">●</span> working…
                    </p>
                  )}
                  {pendingSteps.length > 0 && <AgentActivity steps={pendingSteps} live />}
                  {error && (
                    <div
                      className="flex items-start justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
                      role="alert"
                    >
                      <span>{error}</span>
                      <button
                        type="button"
                        aria-label="Dismiss error"
                        onClick={() => setError(null)}
                        className="shrink-0 px-1 text-destructive/70 transition-colors hover:text-destructive"
                      >
                        ×
                      </button>
                    </div>
                  )}
                  <div ref={bottomRef} />
                </div>
              </div>

              {/* Composer + approval */}
              <div className="shrink-0 border-t border-border/60">
                <div className="mx-auto w-full max-w-3xl px-4 py-3 sm:px-6">
                  {needsConfirm && (
                    <div className="mb-2 flex flex-wrap items-center gap-3 rounded-md border border-border bg-muted/40 px-3 py-2">
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
                  {attachmentChips}
                  {composer}
                  <p className="mt-1.5 hidden text-[10px] text-muted-foreground/70 sm:block">
                    Enter sends · Shift+Enter breaks the line · files you attach travel with the task
                  </p>
                </div>
              </div>
            </>
          )}
        </main>
      </div>
      </PageFade>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state — same shape as the chat empty state: pick a task, it starts.
// ---------------------------------------------------------------------------

function EmptyAgent({ userName, onPick, busy }: { userName: string; onPick: (text: string) => void; busy: boolean }) {
  const examples = [
    'Make a customer support bot for my store.',
    'Build a restaurant bot with a welcome flow and an order flow.',
    'Add a Contact button that shows our support channels.',
  ];
  const firstName = userName ? userName.split(' ')[0] : '';
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6">
      <h1 className="text-lg font-medium text-foreground">
        {firstName ? `Hi, ${firstName}.` : 'Bot Builder.'}
      </h1>
      <p className="mt-2 max-w-sm text-center text-sm leading-relaxed text-muted-foreground">
        Describe the Telegram bot you want — the agent builds it, and you approve
        anything before it goes live.
      </p>
      <div className="mt-6 flex max-w-md flex-wrap items-center justify-center gap-x-4 gap-y-1.5">
        {examples.map((t) => (
          <button
            key={t}
            type="button"
            disabled={busy}
            onClick={() => onPick(t)}
            className="text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline disabled:opacity-50"
          >
            {t}
          </button>
        ))}
      </div>
    </div>
  );
}

function AgentMessage({ entry }: { entry: EntryDTO }) {
  if (entry.role === 'user') {
    return (
      <div className="flex flex-col items-end gap-1">
        {entry.attachments.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1.5">
            {entry.attachments.map((a) => (
              <span key={a.fileId} className="rounded-md border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                {a.name}
              </span>
            ))}
          </div>
        )}
        <div className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-muted/70 px-3.5 py-2 text-sm leading-relaxed text-foreground">
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
      {entry.activity.length > 0 && <AgentActivity steps={entry.activity} />}
      {entry.content ? <Markdown>{entry.content}</Markdown> : null}
    </div>
  );
}

/** Understandable progress — subtle, sourced from the audit trail. Shared AgentActivity renders tool calls AND their outputs. */
