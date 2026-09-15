'use client';

/**
 * NURAE — Operator console (admin dashboard → Agent): the PLATFORM agent.
 *
 * One persistent workspace per server. The admin types a goal in plain
 * language; the agent reads the platform through its audited tools, acts,
 * and reports with numbers. Consequential platform tools (site settings)
 * wait for an explicit Approve — the model can never approve for itself.
 * History is durable server-side (ChatEntry), so the console survives reloads.
 *
 * Visual language: the same typographic conversation surface as the user
 * agent view — no cards, no emoji, quick goals as quiet text links.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Markdown } from '@/components/nurae/markdown';
import { AgentActivity } from '@/components/nurae/agent-activity';
import { ApiError, OperatorEntryDTO, OperatorStepDTO, OperatorToolDTO, nuraeApi } from '@/lib/nurae-client/api';

const QUICK_GOALS = [
  'How is the platform doing?',
  'Fleet status',
  'Why are bots failing? Check the logs',
  'Busiest bots this week',
  'Who are my newest customers?',
];

export function OperatorAgentView() {
  const [entries, setEntries] = useState<OperatorEntryDTO[]>([]);
  const [tools, setTools] = useState<OperatorToolDTO[]>([]);
  const [needsConfirm, setNeedsConfirm] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await nuraeApi.operatorGet();
        setEntries(r.entries ?? []);
        setTools(r.tools ?? []);
        setNeedsConfirm(r.needsConfirm);
      } catch (e) {
        setError(e instanceof ApiError ? e.message : (e as Error).message);
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  useEffect(() => {
    requestAnimationFrame(() =>
      bottomRef.current?.scrollIntoView({ behavior: loaded ? 'smooth' : 'auto', block: 'end' }),
    );
  }, [entries, busy, loaded]);

  const send = useCallback(
    async (text: string, approve = false) => {
      if (busy) return;
      if (!text.trim() && !approve) return;
      setBusy(true);
      setError(null);
      if (!approve) {
        setEntries((e) => [...e, { role: 'user', content: text.trim(), at: new Date().toISOString() }]);
        setDraft('');
      }
      try {
        const r = await nuraeApi.operatorSend(text, approve);
        setEntries((e) => [
          ...e,
          { role: 'assistant', content: r.reply, activity: r.activity ?? [], at: new Date().toISOString() },
        ]);
        setNeedsConfirm(r.needsConfirm);
      } catch (e) {
        setError(e instanceof ApiError ? e.message : (e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void send(draft);
  };

  return (
    <div className="flex min-h-[calc(100vh-8rem)] flex-col">
      <div>
        <h1 className="text-xl font-semibold text-foreground sm:text-2xl">Operator agent</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Ask, diagnose, configure — the agent reads the platform through audited tools and reports with
          numbers. Site-setting changes wait for your approval.
        </p>
      </div>

      {/* Conversation — typography, not bubbles-in-a-box */}
      <div className="mt-6 min-h-0 flex-1">
        <div className="space-y-5">
          {loaded && entries.length === 0 ? (
            <div className="max-w-md text-sm leading-relaxed text-muted-foreground">
              <p>
                Ask about the platform — <span className="text-foreground">“How is the platform doing?”</span> — the
                agent reads real state: bots, fleet, logs, customers, analytics.
              </p>
              <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1.5">
                {QUICK_GOALS.map((g) => (
                  <button
                    key={g}
                    type="button"
                    disabled={busy}
                    onClick={() => void send(g)}
                    className="text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline disabled:opacity-50"
                  >
                    {g}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {entries.map((entry, i) => (
            <div key={`${entry.at}-${i}`}>
              {entry.role === 'user' ? (
                <div className="flex flex-col items-end gap-1">
                  <div className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-muted/70 px-3.5 py-2 text-sm leading-relaxed text-foreground">
                    {entry.content}
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  {entry.activity && entry.activity.length > 0 && <Steps steps={entry.activity} />}
                  <div className="max-w-none text-sm">
                    <Markdown>{entry.content || '…'}</Markdown>
                  </div>
                </div>
              )}
            </div>
          ))}
          {busy ? (
            <p className="text-xs text-muted-foreground" aria-live="polite">
              <span className="animate-pulse">●</span> working…
            </p>
          ) : null}
          {error ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
              {error}
            </div>
          ) : null}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Approval + composer */}
      <div className="mt-6 shrink-0 border-t border-border/60 pt-3">
        {needsConfirm && !busy ? (
          <div className="mb-3 flex flex-wrap items-center gap-3 rounded-md border border-border bg-muted/40 px-3 py-2">
            <span className="text-xs text-muted-foreground">
              The agent is waiting for your approval to apply a platform change.
            </span>
            <Button size="sm" className="ml-auto" onClick={() => void send('', true)}>
              Approve &amp; apply
            </Button>
          </div>
        ) : null}
        <form onSubmit={submit} className="flex items-end gap-2">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Ask the operator: “why did the Trivia bot stop posting?” …"
            disabled={busy}
            aria-label="Message the operator agent"
            className="bg-transparent"
          />
          <Button type="submit" size="sm" disabled={busy || !draft.trim()} className="h-9 shrink-0">
            {busy ? 'Working…' : 'Send'}
          </Button>
        </form>
        <p className="mt-1.5 hidden text-[10px] text-muted-foreground/70 sm:block">
          {tools.length > 0
            ? `Every call is audit-logged — ${tools.length} platform tools.`
            : 'Every call is audit-logged.'}
        </p>
      </div>
    </div>
  );
}

function Steps({ steps }: { steps: OperatorStepDTO[] }) {
  if (!steps.length) return null;
  return <AgentActivity steps={steps} />;
}
