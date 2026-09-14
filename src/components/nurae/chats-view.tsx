'use client';

/**
 * NURAE — /chats: the conversation environment.
 *
 * Structure (no giant boxes, no dashboard chrome):
 *   hairline header (site chrome) → sidebar | conversation → composer.
 *
 * - Desktop keeps a slim session sidebar; mobile collapses it into a drawer.
 * - Messages are typography, not bubbles: user turns sit right-aligned on a
 *   faint surface; assistant turns are plain markdown on the background.
 * - Composer: auto-growing textarea, Enter sends, Shift+Enter breaks,
 *   attachment button (PDF/MD/TXT/CSV/DOCX/images), busy + error states.
 * - The chat can hand a task to the Bot Builder agent ("Open in Agent").
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { SiteHeader, SiteSplash, useSiteUser } from '@/components/nurae/site-shell';
import { Markdown } from '@/components/nurae/markdown';
import { SessionList } from '@/components/nurae/session-list';
import {
  ApiError,
  EntryDTO,
  FileDTO,
  SessionDTO,
  nuraeApi,
} from '@/lib/nurae-client/api';
import { Button } from '@/components/ui/button';

const ACCEPTED_FILES = '.pdf,.md,.markdown,.txt,.csv,.docx,.json,.log,.png,.jpg,.jpeg,.gif,.webp,.svg';

export function ChatsView() {
  const { user, checked, signOut } = useSiteUser();
  const router = useRouter();
  const params = useSearchParams();
  const activeId = params.get('c');

  const [sessions, setSessions] = useState<SessionDTO[]>([]);
  const [entries, setEntries] = useState<EntryDTO[]>([]);
  const [loadingSession, setLoadingSession] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<FileDTO[]>([]);
  const [uploading, setUploading] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const bottomRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const refreshSessions = useCallback(async () => {
    try {
      const r = await nuraeApi.listSessions('chat');
      setSessions(r.sessions);
    } catch {
      /* signed out or offline — the layout still renders */
    }
  }, []);

  useEffect(() => {
    (async () => {
      if (user) await refreshSessions();
    })();
  }, [user, refreshSessions]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!user || !activeId) {
        setEntries([]);
        return;
      }
      setLoadingSession(true);
      setError(null);
      try {
        const r = await nuraeApi.getSession(activeId);
        if (!cancelled) setEntries(r.entries);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof ApiError && e.status === 404 ? 'This chat does not exist.' : (e as Error).message);
        }
      } finally {
        if (!cancelled) setLoadingSession(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, activeId]);

  const scrollDown = useCallback((smooth = true) => {
    requestAnimationFrame(() =>
      bottomRef.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'end' }),
    );
  }, []);

  useEffect(() => {
    scrollDown(!sending);
  }, [entries, sending, scrollDown]);

  const openSession = (id: string | null) => {
    setDrawerOpen(false);
    router.push(id ? `/chats?c=${id}` : '/chats');
  };

  const send = async () => {
    const text = draft.trim();
    if ((!text && attachments.length === 0) || sending || !activeId) return;
    setSending(true);
    setError(null);
    setDraft('');
    const attachmentIds = attachments.map((a) => a.id);
    const localId = `local-${Date.now()}`;
    const optimistic: EntryDTO = {
      id: localId,
      role: 'user',
      content: text,
      attachments: attachments.map((a) => ({ fileId: a.id, name: a.name, kind: a.kind })),
      activity: [],
      needsConfirm: false,
      draftBotId: null,
      handoff: null,
      createdAt: new Date().toISOString(),
    };
    setEntries((e) => [...e, optimistic]);
    setAttachments([]);
    try {
      const r = await nuraeApi.sendChatMessage(activeId, text, attachmentIds.length ? attachmentIds : undefined);
      setEntries((e) => [
        ...e,
        {
          id: `reply-${Date.now()}`,
          role: 'assistant',
          content: r.reply,
          attachments: [],
          activity: [],
          needsConfirm: false,
          draftBotId: null,
          handoff: r.handoff
            ? { agent: r.handoff.agent, sessionId: r.handoff.sessionId, task: r.handoff.task }
            : null,
          createdAt: new Date().toISOString(),
        },
      ]);
      void refreshSessions();
    } catch (err) {
      // The optimistic user entry was never persisted — remove it so the view
      // matches the server (same rule as the agent view).
      setEntries((e) => e.filter((x) => x.id !== localId));
      setError(err instanceof Error ? err.message : 'The assistant could not reply.');
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  };

  const startNewChatAndSend = async (text: string) => {
    if (sending) return;
    setSending(true);
    setError(null);
    try {
      const { session } = await nuraeApi.createSession({ title: text.slice(0, 60) });
      setDraft('');
      setEntries([]);
      router.replace(`/chats?c=${session.id}`);
      const r = await nuraeApi.sendChatMessage(session.id, text);
      setEntries([
        {
          id: `local-${session.id}`,
          role: 'user',
          content: text,
          attachments: [],
          activity: [],
          needsConfirm: false,
          draftBotId: null,
          handoff: null,
          createdAt: new Date().toISOString(),
        },
        {
          id: `reply-${session.id}`,
          role: 'assistant',
          content: r.reply,
          attachments: [],
          activity: [],
          needsConfirm: false,
          draftBotId: null,
          handoff: r.handoff
            ? { agent: r.handoff.agent, sessionId: r.handoff.sessionId, task: r.handoff.task }
            : null,
          createdAt: new Date().toISOString(),
        },
      ]);
      void refreshSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the chat.');
    } finally {
      setSending(false);
    }
  };

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

  if (!checked) return <SiteSplash />;

  if (!user) {
    return (
      <div className="flex min-h-screen flex-col bg-background">
        <SiteHeader variant="public" user={null} />
        <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-16">
          <h1 className="text-lg font-medium text-foreground">Sign in to chat</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            NURAE chats are part of your account — conversations, files and agents stay yours.
          </p>
          <Link href="/" className="mt-6 inline-flex w-fit">
            <Button size="sm">Sign in or create an account</Button>
          </Link>
        </main>
      </div>
    );
  }

  const activeTitle = sessions.find((s) => s.id === activeId)?.title ?? 'New chat';

  return (
    <div className="flex h-dvh flex-col bg-background">
      <SiteHeader user={user} onSignOut={signOut} />

      <div className="flex min-h-0 flex-1">
        {/* Sidebar — desktop */}
        <aside className="hidden w-64 shrink-0 flex-col border-r border-border/60 md:flex">
          <div className="p-3">
            <button
              type="button"
              onClick={() => openSession(null)}
              className="w-full border border-border px-3 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-muted/60"
            >
              + New chat
            </button>
          </div>
          <SessionList
            sessions={sessions}
            activeId={activeId}
            emptyText="No conversations yet. Start one — it stays here."
            onOpen={openSession}
            onRename={renameSession}
            onDelete={deleteSession}
            onArchive={archiveSession}
          />
        </aside>

        {/* Sidebar — mobile drawer */}
        {drawerOpen && (
          <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true">
            <div className="absolute inset-0 bg-black/60" onClick={() => setDrawerOpen(false)} />
            <div className="absolute inset-y-0 left-0 flex w-72 flex-col border-r border-border bg-background">
              <div className="flex items-center justify-between p-3">
                <span className="text-xs uppercase tracking-widest text-muted-foreground">Chats</span>
                <button type="button" onClick={() => setDrawerOpen(false)} className="text-xs text-muted-foreground hover:text-foreground">
                  Close
                </button>
              </div>
              <div className="px-3 pb-3">
                <button
                  type="button"
                  onClick={() => openSession(null)}
                  className="w-full border border-border px-3 py-1.5 text-left text-xs text-foreground hover:bg-muted/60"
                >
                  + New chat
                </button>
              </div>
              <SessionList
                sessions={sessions}
                activeId={activeId}
                emptyText="No conversations yet. Start one — it stays here."
                onOpen={openSession}
                onRename={renameSession}
                onDelete={deleteSession}
                onArchive={archiveSession}
              />
            </div>
          </div>
        )}

        {/* Conversation */}
        <main className="flex min-w-0 flex-1 flex-col">
          {!activeId ? (
            <EmptyChat
              userName={user.name}
              onPick={(text) => void startNewChatAndSend(text)}
              busy={sending}
            />
          ) : (
            <>
              <div className="flex items-center justify-between border-b border-border/60 px-4 py-2 sm:px-6">
                <button
                  type="button"
                  onClick={() => setDrawerOpen(true)}
                  className="text-xs text-muted-foreground hover:text-foreground md:hidden"
                >
                  ☰ Chats
                </button>
                <h1 className="truncate text-xs text-muted-foreground md:text-sm">{activeTitle}</h1>
                <Link href="/chats/agents" className="text-xs text-muted-foreground transition-colors hover:text-foreground">
                  Agents
                </Link>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto" onClick={() => setError(null)}>
                <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6 sm:px-6">
                  {loadingSession && <p className="text-xs text-muted-foreground">Loading…</p>}
                  {entries.map((m) => (
                    <Message key={m.id} entry={m} />
                  ))}
                  {sending && (
                    <p className="text-xs text-muted-foreground" aria-label="Assistant is typing">
                      <span className="animate-pulse">●</span> thinking
                    </p>
                  )}
                  {error && (
                    <div className="border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
                      {error}
                    </div>
                  )}
                  <div ref={bottomRef} />
                </div>
              </div>

              {/* Composer */}
              <div className="shrink-0 border-t border-border/60 bg-background">
                <div className="mx-auto w-full max-w-3xl px-4 py-3 sm:px-6">
                  {attachments.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-1.5">
                      {attachments.map((a) => (
                        <span key={a.id} className="inline-flex items-center gap-1.5 border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
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
                  )}
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
                      title={activeId ? 'Attach files' : 'Open a chat first'}
                      onClick={() => fileInputRef.current?.click()}
                      disabled={!activeId || uploading}
                      className="flex h-9 w-9 shrink-0 items-center justify-center border border-border text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
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
                          void send();
                        }
                      }}
                      rows={1}
                      maxLength={8000}
                      placeholder="Write a message…"
                      className="max-h-40 min-h-9 flex-1 resize-none border border-border bg-transparent px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/40"
                      style={{ height: 'auto' }}
                      onInput={(e) => {
                        const el = e.currentTarget;
                        el.style.height = 'auto';
                        el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => void send()}
                      disabled={sending || (!draft.trim() && attachments.length === 0)}
                      className="flex h-9 shrink-0 items-center border border-border px-3 text-xs text-foreground transition-colors hover:bg-muted/60 disabled:opacity-40"
                    >
                      {sending ? '…' : 'Send'}
                    </button>
                  </div>
                  <p className="mt-1.5 hidden text-[10px] text-muted-foreground/70 sm:block">
                    Enter sends · Shift+Enter breaks the line
                  </p>
                </div>
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Messages — typography, not bubbles
// ---------------------------------------------------------------------------

function Message({ entry }: { entry: EntryDTO }) {
  const isUser = entry.role === 'user';
  if (isUser) {
    return (
      <div className="flex flex-col items-end gap-1">
        {entry.attachments.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1.5">
            {entry.attachments.map((a) => (
              <span key={a.fileId} className="border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                {a.name}
              </span>
            ))}
          </div>
        )}
        <div className="max-w-[85%] whitespace-pre-wrap bg-muted/70 px-3.5 py-2 text-sm leading-relaxed text-foreground">
          {entry.content}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Markdown>{entry.content}</Markdown>
      {entry.handoff && (
        <div className="flex items-center gap-3 border-l-2 border-foreground/30 py-1 pl-3">
          <p className="text-xs text-muted-foreground">
            {entry.handoff.task ? `Task: ${entry.handoff.task}` : 'Handed to the Bot Builder agent'}
          </p>
          <Link
            href={`/chats/agents?session=${entry.handoff.sessionId}`}
            className="text-xs font-medium text-foreground underline-offset-4 hover:underline"
          >
            Open in Agent →
          </Link>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state — human, quiet, no marketing
// ---------------------------------------------------------------------------

function EmptyChat({ userName, onPick, busy }: { userName: string; onPick: (text: string) => void; busy: boolean }) {
  const examples = [
    'What can NURAE do?',
    'Explain Telegram inline keyboards.',
    'Build me a Telegram bot for my clothing store.',
  ];
  // Featured page handoff: a picked question lands here as a prefill.
  const [prefill, setPrefill] = useState<string | null>(null);
  useEffect(() => {
    (async () => {
      try {
        const stored = sessionStorage.getItem('nurae:prefill');
        if (stored) {
          sessionStorage.removeItem('nurae:prefill');
          setPrefill(stored);
        }
      } catch {
        /* ignore */
      }
    })();
  }, []);
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 pb-24">
      <h1 className="text-lg font-medium text-foreground">
        {userName ? `Hi, ${userName}.` : 'Hello.'}
      </h1>
      <p className="mt-2 max-w-sm text-center text-sm leading-relaxed text-muted-foreground">
        Ask anything, or hand work to an agent. Files you attach travel with the conversation.
      </p>
      <div className="mt-8 w-full max-w-md space-y-px">
        {examples.map((t) => (
          <button
            key={t}
            type="button"
            disabled={busy}
            onClick={() => onPick(t)}
            className="block w-full border border-border/60 px-3 py-2 text-left text-xs text-muted-foreground transition-colors first:border-t hover:border-border hover:text-foreground disabled:opacity-50"
          >
            {t}
          </button>
        ))}
      </div>
      {prefill && (
        <button
          type="button"
          onClick={() => onPick(prefill)}
          disabled={busy}
          className="mt-4 max-w-md border border-border px-3 py-2 text-left text-xs text-foreground transition-colors hover:bg-muted/50 disabled:opacity-50"
        >
          Continue: “{prefill}”
        </button>
      )}
      <p className="mt-6 text-[11px] text-muted-foreground/70">
        Build requests are routed to the Bot Builder agent — you approve anything before it goes live.
      </p>
    </div>
  );
}
