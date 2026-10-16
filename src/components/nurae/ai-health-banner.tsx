'use client';

/**
 * NURAE admin - AI provider key health banner.
 * Silent when the platform key works; a clear, actionable alert when it does
 * not (dead / missing key, provider unreachable) so the owner finds out here
 * instead of from users hitting "the AI layer rejected its credentials".
 */

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { RefreshIcon } from '@/components/nurae/icons';

interface AiHealth {
  status: 'ok' | 'invalid' | 'missing' | 'unreadable' | 'unreachable' | 'unconfigured';
  ok: boolean;
  provider: string | null;
  model: string | null;
  envVar: string | null;
  keySource?: 'stored' | 'env' | null;
  storedUnreadable?: boolean;
  detail: string;
  checkedAt: string;
}

const TITLES: Record<AiHealth['status'], string> = {
  ok: 'AI provider connected',
  invalid: 'AI key rejected - agents and official bots are offline',
  missing: 'No AI key configured - agents and official bots are offline',
  unreadable: 'Stored AI key unreadable - re-enter it in the bot settings',
  unreachable: 'AI provider unreachable',
  unconfigured: 'Official bot not set up yet',
};

export function AiHealthBanner() {
  const [health, setHealth] = useState<AiHealth | null>(null);
  const [checking, setChecking] = useState(false);

  const load = useCallback(async (refresh: boolean) => {
    setChecking(true);
    try {
      const res = await fetch(`/api/ai-health${refresh ? '?refresh=1' : ''}`, { cache: 'no-store' });
      if (res.ok) setHealth((await res.json()) as AiHealth);
    } catch {
      /* non-fatal: the banner simply stays hidden */
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    const kick = setTimeout(() => void load(false), 0);
    return () => clearTimeout(kick);
  }, [load]);

  if (!health || health.ok) return null;

  return (
    <div
      role="alert"
      className="flex flex-col gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-4 sm:flex-row sm:items-start sm:justify-between"
    >
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium text-destructive">{TITLES[health.status]}</p>
        <p className="text-sm text-muted-foreground">{health.detail}</p>
        {health.provider && (
          <p className="text-xs text-muted-foreground">
            Provider: {health.provider}
            {health.model ? ` · model: ${health.model}` : ''}
            {health.envVar ? ` · env var: ${health.envVar}` : ''}
            {health.keySource ? ` · key source: ${health.keySource === 'stored' ? 'bot settings (overrides .env)' : '.env fallback'}` : ''}
          </p>
        )}
      </div>
      <Button size="sm" variant="outline" disabled={checking} onClick={() => void load(true)} className="shrink-0">
        <RefreshIcon className={checking ? 'animate-spin' : undefined} />
        Re-check
      </Button>
    </div>
  );
}
