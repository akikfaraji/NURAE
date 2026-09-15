'use client';

/**
 * NURAE — bot ecosystem sections: Audience, Broadcast, Schedule, Payments.
 * The owner-facing surfaces of the runtime powers (per-user state, paced
 * fan-out, the reminder queue, the Stars ledger). Same typographic language
 * as the rest of the bot detail view — hairlines, no cards.
 */

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { nuraeApi, ApiError, type BroadcastDTO, type BotScheduleDTO, type BotPaymentDTO, type BotUserStateDTO } from '@/lib/nurae-client/api';
import { LoadingRow } from '@/components/nurae/bits';

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="mt-10 border-t border-border/60 pt-6">
      <h2 className="text-xs font-medium uppercase tracking-widest text-muted-foreground">{title}</h2>
      {hint && <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground/80">{hint}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

const fmtTime = (iso: string) => `${iso.replace('T', ' ').slice(0, 16)} UTC`;

// ---------------------------------------------------------------------------
// Audience — who talks to the bot and what it remembered
// ---------------------------------------------------------------------------

export function AudienceSection({ botId, refreshKey }: { botId: string; refreshKey: number }) {
  const [users, setUsers] = useState<BotUserStateDTO[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    nuraeApi
      .listMyBotUsers(botId)
      .then((r) => {
        if (!alive) return;
        setUsers(r.users);
        setTotal(r.total);
        setError(null);
      })
      .catch((err) => alive && setError(err instanceof ApiError ? err.message : 'Could not load the audience.'));
    return () => {
      alive = false;
    };
  }, [botId, refreshKey]);

  return (
    <Section
      title="Audience"
      hint="Everyone who has talked to this bot, with what it remembered — collected answers, carts, the link they arrived from."
    >
      {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
      {!error && users === null && <LoadingRow />}
      {users !== null && users.length === 0 && (
        <p className="text-xs text-muted-foreground">No one yet. Publish the bot and the first conversation appears here.</p>
      )}
      {users !== null && users.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {total} chat{total === 1 ? '' : 's'}
            {total > users.length ? ` (showing ${users.length})` : ''}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-border/60 text-muted-foreground">
                  <th className="py-1.5 pr-4 font-medium">Chat</th>
                  <th className="py-1.5 pr-4 font-medium">Remembered</th>
                  <th className="py-1.5 font-medium">Arrived via</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.chatId} className="border-b border-border/40 align-top">
                    <td className="py-1.5 pr-4 font-mono">{u.chatId}</td>
                    <td className="py-1.5 pr-4">
                      {Object.keys(u.attributes).length === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <span className="font-mono">
                          {Object.entries(u.attributes)
                            .slice(0, 6)
                            .map(([k, v]) => `${k}: ${v.length > 40 ? `${v.slice(0, 40)}…` : v}`)
                            .join(' · ')}
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 font-mono text-muted-foreground">{u.startPayload ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Broadcast — one message to everyone, queued + paced
// ---------------------------------------------------------------------------

export function BroadcastSection({ botId, refreshKey, onSent }: { botId: string; refreshKey: number; onSent: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [history, setHistory] = useState<BroadcastDTO[] | null>(null);

  const load = useCallback(() => {
    nuraeApi
      .listMyBotBroadcasts(botId)
      .then((r) => setHistory(r.broadcasts))
      .catch(() => setHistory([]));
  }, [botId]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const send = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await nuraeApi.broadcastMyBot(botId, text.trim());
      setNotice(`Queued to ${r.broadcast.total} chat${r.broadcast.total === 1 ? '' : 's'} — delivery runs in the background at ~20 messages/second.`);
      setText('');
      onSent();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not queue the broadcast.');
    } finally {
      setBusy(false);
      load();
    }
  };

  return (
    <Section
      title="Broadcast"
      hint="One message to every chat that ever wrote to the bot — newsletters, announcements. Queued and paced under Telegram's limits; blocked chats are counted, never retried forever."
    >
      <div className="flex items-end gap-2">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="What should everyone hear? Markdown renders."
          maxLength={4000}
          className="bg-transparent text-sm"
        />
        <Button size="sm" variant="outline" disabled={busy || !text.trim()} onClick={() => void send()}>
          {busy ? '…' : 'Queue'}
        </Button>
      </div>
      {error && <p className="mt-2 text-xs text-destructive" role="alert">{error}</p>}
      {notice && <p className="mt-2 text-xs text-muted-foreground" role="status">{notice}</p>}
      {history !== null && history.length > 0 && (
        <ul className="mt-4 space-y-1.5 text-xs">
          {history.slice(0, 5).map((b) => (
            <li key={b.id} className="flex flex-wrap items-baseline gap-x-3 border-b border-border/40 pb-1.5">
              <span className="font-mono text-muted-foreground">{fmtTime(b.createdAt)}</span>
              <span
                className={
                  b.status === 'done'
                    ? 'text-foreground'
                    : b.status === 'failed'
                      ? 'text-destructive'
                      : 'text-muted-foreground'
                }
              >
                {b.status}
              </span>
              <span className="text-muted-foreground">
                {b.sent}/{b.total} sent{b.failed ? `, ${b.failed} failed` : ''}
              </span>
              <span className="max-w-md truncate">{b.text}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Schedule — the reminder / drip queue
// ---------------------------------------------------------------------------

export function SchedulesSection({ botId, refreshKey }: { botId: string; refreshKey: number }) {
  const [rows, setRows] = useState<BotScheduleDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    nuraeApi
      .listMyBotSchedules(botId)
      .then((r) => {
        setRows(r.schedules);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load the schedule.'));
  }, [botId]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const cancel = async (scheduleId: string) => {
    try {
      await nuraeApi.cancelMyBotSchedule(botId, scheduleId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not cancel.');
    }
    load();
  };

  return (
    <Section
      title="Schedule"
      hint="Reminders and drip messages the bot will send. Recurring rows re-arm at the same time (UTC). The bot's own “remind me” flow creates these automatically."
    >
      {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
      {!error && rows === null && <LoadingRow />}
      {rows !== null && rows.length === 0 && (
        <p className="text-xs text-muted-foreground">Nothing scheduled. Add a “set a reminder” step to a behavior and this fills itself.</p>
      )}
      {rows !== null && rows.length > 0 && (
        <ul className="space-y-1.5 text-xs">
          {rows.map((s) => (
            <li key={s.id} className="flex flex-wrap items-baseline gap-x-3 border-b border-border/40 pb-1.5">
              <span className="font-mono text-muted-foreground">{fmtTime(s.runAt)}</span>
              <span className="text-muted-foreground">{s.recurrence}</span>
              {s.status === 'failed' && <span className="text-destructive">failed</span>}
              <span className="max-w-md truncate">{s.text}</span>
              <span className="font-mono text-muted-foreground">→ {s.chatId}</span>
              {s.status === 'pending' && (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <button type="button" className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
                      cancel
                    </button>
                  </AlertDialogTrigger>
                  <AlertDialogContent className="border-border bg-background">
                    <AlertDialogHeader>
                      <AlertDialogTitle className="text-sm">Cancel this scheduled message?</AlertDialogTitle>
                      <AlertDialogDescription className="text-xs text-muted-foreground">
                        “{s.text.slice(0, 120)}” — it will never be sent.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel className="text-xs">Keep</AlertDialogCancel>
                      <AlertDialogAction className="text-xs" onClick={() => void cancel(s.id)}>
                        Cancel it
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Payments — the Stars ledger
// ---------------------------------------------------------------------------

export function PaymentsSection({ botId, refreshKey }: { botId: string; refreshKey: number }) {
  const [payments, setPayments] = useState<BotPaymentDTO[] | null>(null);
  const [totalStars, setTotalStars] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    nuraeApi
      .listMyBotPayments(botId)
      .then((r) => {
        if (!alive) return;
        setPayments(r.payments);
        setTotalStars(r.totalStars);
        setError(null);
      })
      .catch((err) => alive && setError(err instanceof ApiError ? err.message : 'Could not load payments.'));
    return () => {
      alive = false;
    };
  }, [botId, refreshKey]);

  return (
    <Section
      title="Payments"
      hint="Completed Telegram Stars payments (digital goods must be sold in Stars — Telegram's store policy). Refunds are manual this release."
    >
      {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
      {!error && payments === null && <LoadingRow />}
      {payments !== null && payments.length === 0 && (
        <p className="text-xs text-muted-foreground">No payments yet. Add a payment step to a behavior and the ledger starts itself.</p>
      )}
      {payments !== null && payments.length > 0 && (
        <ul className="space-y-1.5 text-xs">
          <li className="text-muted-foreground">Total: {totalStars} ★</li>
          {payments.map((p, i) => (
            <li key={`${p.chatId}-${i}`} className="flex flex-wrap items-baseline gap-x-3 border-b border-border/40 pb-1.5">
              <span className="font-mono text-muted-foreground">{fmtTime(p.createdAt)}</span>
              <span>{p.amount} ★</span>
              <span>{p.title}</span>
              <span className="font-mono text-muted-foreground">chat {p.chatId}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
