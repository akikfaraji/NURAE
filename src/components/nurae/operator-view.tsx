'use client';

/**
 * NURAE — Operator console (admin dashboard → Agent): the PLATFORM agent.
 *
 * One persistent workspace per server ("Operator console"). The admin types
 * a goal in plain language; the agent reads the platform through its tool
 * tier (overview, fleet, any bot's config, logs, settings, customers,
 * analytics), acts, and reports with numbers. Consequential platform tools
 * (site settings) wait for the explicit Approve control — the model can
 * never approve for itself. History is durable server-side (ChatEntry), so
 * the console survives reloads.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Markdown } from '@/components/nurae/markdown';
import { ApiError, OperatorEntryDTO, OperatorStepDTO, OperatorToolDTO, nuraeApi } from '@/lib/nurae-client/api';

const QUICK_GOALS = [
  'How is the platform doing?',
  'Fleet status',
  'Why are bots failing? Check the logs',
  'Busiest bots this week',
  'Who are my newest customers?',
];

function StepChips({ steps }: { steps: OperatorStepDTO[] }) {
  if (!steps.length) return null;
  return (
    <div className="mt-2 space-y-1">
      {steps.map((s) => (
        <div key={s.seq} className="flex items-start gap-2 text-xs">
          <span
            className={
              'mt-0.5 inline-block h-2 w-2 shrink-0 rounded-full ' +
              (s.status === 'ok'
                ? 'bg-foreground'
                : s.status === 'confirm'
                  ? 'bg-muted-foreground'
                  : 'bg-destructive')
            }
            aria-hidden
          />
          <span className="text-muted-foreground">
            <span className="font-mono text-[11px] text-foreground/70">{s.tool}</span>
            {s.detail ? ` — ${s.label} (${s.detail})` : ` — ${s.label}`}
          </span>
        </div>
      ))}
    </div>
  );
}

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
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-foreground sm:text-2xl">Operator agent</h1>
        <p className="text-sm text-muted-foreground">
          Ask, diagnose, configure — the agent reads the platform through audited tools and reports with numbers.
          Site-setting changes wait for your approval.
        </p>
      </div>

      <Card className="border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Operator console</CardTitle>
          <CardDescription>
            {tools.length
              ? `${tools.length} platform tools available — every call is audit-logged.`
              : 'The agent works through audited platform tools.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="h-[52vh] min-h-[320px] space-y-3 overflow-y-auto rounded-md border border-border bg-muted/30 p-3">
            {loaded && entries.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
                <span className="text-2xl" aria-hidden>
                  ⚡
                </span>
                <p className="max-w-md">
                  Try: <span className="text-foreground">“How is the platform doing?”</span> — or pick a goal below.
                  The agent reads real state: bots, fleet, logs, customers, analytics.
                </p>
              </div>
            ) : null}
            {entries.map((entry, i) => (
              <div key={`${entry.at}-${i}`} className={entry.role === 'user' ? 'flex justify-end' : ''}>
                <div
                  className={
                    'max-w-[88%] rounded-lg px-3 py-2 text-sm ' +
                    (entry.role === 'user'
                      ? 'bg-foreground text-background'
                      : 'border border-border bg-background text-foreground')
                  }
                >
                  {entry.role === 'assistant' ? (
                    <div className="max-w-none">
                      <Markdown>{entry.content || '…'}</Markdown>
                    </div>
                  ) : (
                    <span className="whitespace-pre-wrap">{entry.content}</span>
                  )}
                  {entry.activity ? <StepChips steps={entry.activity} /> : null}
                </div>
              </div>
            ))}
            {busy ? (
              <div className="text-xs text-muted-foreground" aria-live="polite">
                Operator is working…
              </div>
            ) : null}
            <div ref={bottomRef} />
          </div>

          <div className="flex flex-wrap gap-1.5">
            {QUICK_GOALS.map((g) => (
              <button
                key={g}
                type="button"
                disabled={busy}
                onClick={() => void send(g)}
                className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
              >
                {g}
              </button>
            ))}
          </div>

          {needsConfirm && !busy ? (
            <div className="flex items-center justify-between gap-3 rounded-md border border-foreground/30 bg-muted px-3 py-2 text-sm">
              <span>The agent is waiting for your approval to apply a platform change.</span>
              <Button size="sm" onClick={() => void send('', true)}>
                Approve &amp; apply
              </Button>
            </div>
          ) : null}

          {error ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          ) : null}

          <form onSubmit={submit} className="flex gap-2">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Ask the operator: “why did the Trivia bot stop posting?” …"
              disabled={busy}
              aria-label="Message the operator agent"
            />
            <Button type="submit" disabled={busy || !draft.trim()}>
              {busy ? 'Working…' : 'Send'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
