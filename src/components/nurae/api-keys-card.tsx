'use client';

/**
 * NURAE — API keys card (user dashboard section).
 *
 * External AI agents (Claude, GPT, anything that speaks HTTP) operate NURAE
 * with Bearer AgentTokens. This card is where a customer mints and revokes
 * their own keys. The raw key is returned by the server exactly once and is
 * never persisted — so the reveal block below is deliberately loud: copy it
 * now, it will not be offered again.
 *
 * Design language: same quiet hairline rows as the rest of the dashboard;
 * the only emphasis is the one-time key reveal, because that genuinely is
 * the one moment that matters.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AgentTokenDTO, ApiError, nuraeApi } from '@/lib/nurae-client/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';

function shortDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function ApiKeysCard() {
  const [tokens, setTokens] = useState<AgentTokenDTO[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [allowConsequential, setAllowConsequential] = useState(false);
  const [minting, setMinting] = useState(false);
  const [revealed, setRevealed] = useState<{ key: string; name: string } | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const confirmTimer = useRef<number | null>(null);
  const revealRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await nuraeApi.myTokens();
      setTokens(res.tokens);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : (err as Error).message);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time mount load: the state updates happen inside an async fetch, the synchronous call only kicks it off
    void load();
    return () => {
      if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current);
    };
  }, [load]);

  useEffect(() => {
    if (revealed && revealRef.current) revealRef.current.scrollIntoView({ block: 'nearest' });
  }, [revealed]);

  const mint = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error('Give the key a name first — what is it for?');
      return;
    }
    setMinting(true);
    try {
      const res = await nuraeApi.mintToken(trimmed, allowConsequential);
      setRevealed({ key: res.token, name: trimmed });
      setName('');
      setAllowConsequential(false);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not mint the key');
    } finally {
      setMinting(false);
    }
  };

  const revoke = async (id: string) => {
    if (confirmId !== id) {
      // two-click confirm — same idiom as destructive actions elsewhere
      setConfirmId(id);
      if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current);
      confirmTimer.current = window.setTimeout(() => setConfirmId(null), 3000);
      return;
    }
    if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current);
    setConfirmId(null);
    setBusyId(id);
    try {
      await nuraeApi.revokeToken(id);
      toast.success('Key revoked — agents using it stop working immediately');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Revoke failed');
    } finally {
      setBusyId(null);
    }
  };

  const copyKey = async () => {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed.key);
      toast.success('Key copied');
    } catch {
      toast.error('Copy failed — select the key text manually');
    }
  };

  const active = (tokens ?? []).filter((t) => !t.revokedAt);
  const revokedCount = (tokens ?? []).length - active.length;

  return (
    <section className="mt-10" aria-label="API keys">
      <h2 className="text-xs font-medium uppercase tracking-widest text-muted-foreground">API keys</h2>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
        Let an external AI agent — Claude, GPT, your own scripts — operate NURAE as you:
        send it the key with{' '}
        <code className="font-mono text-[11px] text-foreground">Authorization: Bearer</code> and point it at{' '}
        <a href="/api/openapi.json" className="font-mono text-[11px] text-foreground underline-offset-2 hover:underline">
          /api/openapi.json
        </a>{' '}
        to discover everything. Writes that matter stay gated behind your approval rules below.
      </p>

      {loadError ? (
        <div className="mt-3 border border-border/60 p-4">
          <p className="text-sm text-foreground">{loadError}</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      ) : tokens === null ? (
        <p className="mt-3 text-sm text-muted-foreground" role="status">Loading keys…</p>
      ) : (
        <>
          {active.length > 0 && (
            <ul className="mt-3 border-t border-border/60">
              {active.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border/60 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2.5">
                      <span className="truncate text-sm font-medium text-foreground">{t.name}</span>
                      {t.allowConsequential && (
                        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">writes approved</span>
                      )}
                    </div>
                    <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                      {t.prefix}… · minted {shortDate(t.createdAt)} · {t.lastUsedAt ? `last used ${shortDate(t.lastUsedAt)}` : 'never used'}
                    </p>
                  </div>
                  <span className="inline-flex shrink-0 items-center">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busyId === t.id}
                      onClick={() => void revoke(t.id)}
                    >
                      {confirmId === t.id ? 'Really revoke?' : 'Revoke'}
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {active.length === 0 && (
            <p className="mt-3 text-sm text-muted-foreground">
              No keys yet — mint one and hand it to your agent.
            </p>
          )}
          {revokedCount > 0 && (
            <p className="mt-2 text-[11px] text-muted-foreground">
              {revokedCount} revoked {revokedCount === 1 ? 'key' : 'keys'} hidden.
            </p>
          )}

          {/* mint form */}
          <div className="mt-4 max-w-xl">
            {revealed ? (
              <div ref={revealRef} className="border border-border bg-muted/30 p-4">
                <p className="text-sm font-medium text-foreground">
                  “{revealed.name}” is live — copy the key now
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  It is not stored anywhere and will never be shown again.
                </p>
                <div className="mt-3 break-all rounded-sm bg-background p-3 font-mono text-xs text-foreground">
                  {revealed.key}
                </div>
                <div className="mt-3 flex gap-2">
                  <Button size="sm" onClick={() => void copyKey()}>Copy key</Button>
                  <Button size="sm" variant="ghost" onClick={() => setRevealed(null)}>
                    Done — I saved it
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Key name — e.g. “Claude”"
                  className="h-9 max-w-56"
                  maxLength={80}
                  aria-label="Key name"
                />
                <Button size="sm" disabled={minting} onClick={() => void mint()}>
                  {minting ? 'Minting…' : 'Mint key'}
                </Button>
                <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={allowConsequential}
                    onChange={(e) => setAllowConsequential(e.target.checked)}
                    className="accent-foreground"
                  />
                  approve writes without per-call confirm
                </label>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
