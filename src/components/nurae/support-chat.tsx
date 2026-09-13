'use client';

/**
 * NURAE — customer support chat (public site, signed-in customers).
 * Talks to the official NURAE CS bot through POST /api/support/chat.
 * History is persisted server-side (Conversation/Message rows).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ChatMessageDTO, SessionUserDTO, nuraeApi } from '@/lib/nurae-client/api';
import { SendIcon } from '@/components/nurae/icons';

interface SupportChatProps {
  user: SessionUserDTO;
  welcomeMessage: string;
  botUsername: string | null;
  onSignedOut: () => void;
}

export function SupportChat({ user, welcomeMessage, botUsername, onSignedOut }: SupportChatProps) {
  const [messages, setMessages] = useState<ChatMessageDTO[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const scrollDown = useCallback(() => {
    requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }));
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const h = await nuraeApi.supportHistory();
        setMessages(h.messages);
      } catch {
        /* fresh chat */
      } finally {
        setLoaded(true);
        scrollDown();
      }
    })();
  }, [scrollDown]);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setNotice(null);
    setDraft('');
    const now = new Date().toISOString();
    setMessages((m) => [...m, { id: `local-${now}`, role: 'user', content: text, timestamp: now }]);
    scrollDown();
    try {
      const { reply } = await nuraeApi.supportChat(text);
      setMessages((m) => [
        ...m,
        { id: `reply-${Date.now()}`, role: 'assistant', content: reply, timestamp: new Date().toISOString() },
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'The assistant could not reply.';
      setNotice(message);
      // Keep the user's message visible; nothing else to clean up.
    } finally {
      setBusy(false);
      scrollDown();
    }
  };

  return (
    <div className="mx-auto flex h-[calc(100vh-8.5rem)] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-card">
      {/* Chat header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-md bg-foreground text-sm font-bold text-background">
            N
          </span>
          <div>
            <div className="text-sm font-medium text-foreground">NURAE CS Bot</div>
            <div className="text-[11px] uppercase tracking-widest text-muted-foreground">
              {botUsername ? botUsername : 'official support'}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden text-xs text-muted-foreground sm:block">{user.email}</span>
          <Button variant="outline" size="sm" onClick={onSignedOut}>
            Sign out
          </Button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        <Bubble role="assistant" content={welcomeMessage} />
        {!loaded ? (
          <div className="text-center text-xs text-muted-foreground">Loading your chat…</div>
        ) : (
          messages.map((m) => <Bubble key={m.id} role={m.role} content={m.content} />)
        )}
        {busy && (
          <div className="flex items-center gap-1.5 pl-1 text-muted-foreground" aria-label="Assistant is typing">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-foreground" />
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-foreground [animation-delay:150ms]" />
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-foreground [animation-delay:300ms]" />
          </div>
        )}
        {notice && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {notice}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Composer */}
      <form onSubmit={send} className="flex items-center gap-2 border-t border-border px-3 py-3">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Ask about NURAE — bots, providers, keys…"
          maxLength={2000}
          disabled={busy}
          aria-label="Message"
        />
        <Button type="submit" size="icon" disabled={busy || !draft.trim()} aria-label="Send">
          <SendIcon className="h-4 w-4" />
        </Button>
      </form>
    </div>
  );
}

function Bubble({ role, content }: { role: string; content: string }) {
  const isUser = role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={
          isUser
            ? 'max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-foreground px-4 py-2.5 text-sm text-background'
            : 'max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-bl-sm border border-border bg-muted/60 px-4 py-2.5 text-sm text-foreground'
        }
      >
        {content}
      </div>
    </div>
  );
}
