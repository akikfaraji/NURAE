'use client';

/**
 * NURAE dashboard — bot detail: status, controls (Start/Stop/Restart),
 * configuration editor, and live logs.
 */

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { BotForm } from '@/components/nurae/bot-form';
import { BotMeta, Pill, StatusBadge } from '@/components/nurae/bits';
import { BotDTO, Catalog, LogEntry, nuraeApi } from '@/lib/nurae-client/api';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

const LOG_COLORS: Record<LogEntry['level'], string> = {
  info: 'text-muted-foreground',
  warn: 'text-muted-foreground',
  error: 'text-destructive',
};

function timeOf(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return ts;
  }
}

export function BotView({ botId, catalog, onBack }: { botId: string; catalog: Catalog; onBack: () => void }) {
  const [bot, setBot] = useState<BotDTO | null>(null);
  const [runtime, setRuntime] = useState<{ managed: boolean; transport: string | null; pendingUpdateCount: number | null }>({
    managed: false,
    transport: null,
    pendingUpdateCount: null,
  });
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [configErrors, setConfigErrors] = useState<Record<string, string>>({});
  const [logFilter, setLogFilter] = useState<'all' | LogEntry['level']>('all');

  const refreshBot = useCallback(async () => {
    try {
      const res = await nuraeApi.getBot(botId);
      setBot(res.bot);
      setRuntime({
        managed: res.runtime.managed,
        transport: res.runtime.transport,
        pendingUpdateCount: res.runtime.pendingUpdateCount,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load bot');
    }
  }, [botId]);

  const refreshLogs = useCallback(async () => {
    try {
      const res = await nuraeApi.botLogs(botId, 100);
      setLogs(res.logs);
    } catch {
      /* non-fatal */
    }
  }, [botId]);

  useEffect(() => {
    const kick = setTimeout(() => {
      void refreshBot();
      void refreshLogs();
    }, 0);
    const t = setInterval(() => {
      void refreshBot();
      void refreshLogs();
    }, 4000);
    return () => {
      clearTimeout(kick);
      clearInterval(t);
    };
  }, [refreshBot, refreshLogs]);

  const lifecycle = async (action: 'start' | 'stop' | 'restart') => {
    setBusy(action);
    try {
      const res =
        action === 'start'
          ? await nuraeApi.startBot(botId)
          : action === 'stop'
            ? await nuraeApi.stopBot(botId)
            : await nuraeApi.restartBot(botId);
      setBot(res.bot);
      toast.success(`Bot ${action}ed`, { description: `Runtime status: ${res.runtime.status}` });
      await Promise.all([refreshBot(), refreshLogs()]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Failed to ${action} bot`);
    } finally {
      setBusy(null);
    }
  };

  const verify = async () => {
    setBusy('verify');
    try {
      const res = await nuraeApi.verifyBot(botId);
      toast.info('Verification result', {
        description: `Telegram: ${res.telegram.valid ? 'OK' : res.telegram.detail} · AI provider: ${res.provider.valid ? 'OK' : res.provider.detail}`,
      });
      await refreshBot();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Verification failed');
    } finally {
      setBusy(null);
    }
  };

  const saveConfig = async (input: Parameters<typeof nuraeApi.updateConfig>[1]) => {
    setBusy('config');
    setConfigErrors({});
    try {
      const res = await nuraeApi.updateConfig(botId, input);
      setBot(res.bot);
      setConfigOpen(false);
      toast.success('Configuration saved', { description: res.note });
      await refreshLogs();
    } catch (err) {
      const e = err as { message?: string; fields?: Record<string, string> };
      setConfigErrors(e.fields ?? { _form: e.message ?? 'Failed to save configuration' });
      toast.error(e.message ?? 'Failed to save configuration');
    } finally {
      setBusy(null);
    }
  };

  const removeBot = async () => {
    if (!bot) return;
    setBusy('delete');
    try {
      await nuraeApi.deleteBot(botId);
      toast.success('Bot deleted');
      onBack();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete bot');
      setBusy(null);
    }
  };

  if (!bot) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      </div>
    );
  }

  const filteredLogs = logFilter === 'all' ? logs : logs.filter((l) => l.level === logFilter);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground" onClick={onBack}>
            ← Back
          </Button>
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="truncate text-lg font-semibold text-foreground" data-testid="bot-title">
              {bot.name}
            </h2>
            <StatusBadge status={bot.status} />
            {bot.transport && (
              <Pill>{bot.transport === 'webhook' ? 'webhook transport' : 'polling transport'}</Pill>
            )}
            {runtime.managed && runtime.pendingUpdateCount !== null && runtime.pendingUpdateCount > 5 && (
              <span className="text-xs text-muted-foreground">{runtime.pendingUpdateCount} updates queued</span>
            )}
          </div>
          {bot.statusDetail && (
            <p className="mt-1 max-w-2xl text-sm text-destructive" role="alert">
              {bot.statusDetail}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => lifecycle('start')}
            disabled={busy !== null || bot.status === 'running' || !bot.enabled}
            
            data-testid="start-bot"
          >
            {busy === 'start' ? 'Starting…' : 'Start'}
          </Button>
          <Button
            onClick={() => lifecycle('stop')}
            disabled={busy !== null || bot.status === 'stopped'}
            variant="outline"
            data-testid="stop-bot"
          >
            {busy === 'stop' ? 'Stopping…' : 'Stop'}
          </Button>
          <Button onClick={() => lifecycle('restart')} disabled={busy !== null} variant="outline" data-testid="restart-bot">
            {busy === 'restart' ? 'Restarting…' : 'Restart'}
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Overview</CardTitle>
            <CardDescription>Identity and runtime info.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <BotMeta
              items={[
                { label: 'Telegram', value: bot.telegramUsername ?? 'Not verified yet' },
                { label: 'AI provider', value: bot.provider },
                { label: 'Model', value: bot.model },
                { label: 'Status', value: <StatusBadge status={bot.status} /> },
                { label: 'Transport', value: bot.transport === 'webhook' ? 'Webhook (Telegram → NURAE)' : bot.transport === 'polling' ? 'Polling (local dev)' : 'Not started yet' },
                { label: 'Enabled', value: bot.enabled ? 'Yes' : 'No' },
                {
                  label: 'Last started',
                  value: bot.lastStartedAt ? new Date(bot.lastStartedAt).toLocaleString() : 'Never',
                },
              ]}
            />
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={verify} disabled={busy !== null} data-testid="verify-bot">
                {busy === 'verify' ? 'Verifying…' : 'Verify connections'}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setConfigOpen(true)} data-testid="edit-config">
                Edit configuration
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:bg-destructive/10"
                    disabled={busy !== null}
                    data-testid="delete-bot"
                  >
                    Delete
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete bot “{bot.name}”?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Conversations and logs will be removed. This cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      className="bg-destructive text-white hover:bg-destructive/90"
                      onClick={() => void removeBot()}
                    >
                      Delete bot
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </CardContent>
        </Card>

        <Card className="border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Current configuration</CardTitle>
            <CardDescription>Secrets are encrypted and never displayed.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">System prompt</p>
              <p className="mt-1 whitespace-pre-wrap rounded-md bg-muted/50 p-3 text-sm text-foreground">{bot.systemPrompt}</p>
            </div>
            <BotMeta
              items={[
                { label: 'Temperature', value: bot.temperature.toFixed(1) },
                { label: 'Max output tokens', value: bot.maxTokens },
                { label: 'Memory (messages)', value: bot.memorySize },
                {
                  label: 'Credentials',
                  value: `Telegram token: ${bot.hasTelegramToken ? 'stored' : 'missing'} · API key: ${bot.hasApiKey ? 'stored' : 'not needed'}`,
                },
              ]}
            />
          </CardContent>
        </Card>
      </div>

      <Card className="border-border">
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-base">Logs</CardTitle>
              <CardDescription>Auto-refreshing every 4s. Newest first.</CardDescription>
            </div>
            <div className="flex gap-1">
              {(['all', 'info', 'warn', 'error'] as const).map((level) => (
                <Button
                  key={level}
                  size="sm"
                  variant={logFilter === level ? 'default' : 'ghost'}
                  className={logFilter === level ? 'bg-foreground text-background' : 'text-muted-foreground'}
                  onClick={() => setLogFilter(level)}
                >
                  {level}
                </Button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="max-h-96 overflow-y-auto rounded-md bg-background p-3 font-mono text-xs leading-relaxed" data-testid="logs-panel">
            {filteredLogs.length === 0 ? (
              <p className="p-4 text-center text-muted-foreground">No log entries yet. Start the bot and interact with it on Telegram.</p>
            ) : (
              filteredLogs.map((l) => (
                <p key={l.id} className={cn('whitespace-pre-wrap break-words py-0.5', LOG_COLORS[l.level])}>
                  <span className="text-muted-foreground">{timeOf(l.timestamp)} </span>
                  <span className="uppercase text-muted-foreground">[{l.level}] </span>
                  {l.message}
                </p>
              ))
            )}
          </div>
        </CardContent>
      </Card>

      <Dialog open={configOpen} onOpenChange={setConfigOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Edit configuration</DialogTitle>
            <DialogDescription>Changes apply after the next bot start/restart.</DialogDescription>
          </DialogHeader>
          <BotForm
            catalog={catalog}
            bot={bot}
            submitLabel="Save configuration"
            busy={busy === 'config'}
            serverErrors={configErrors}
            onCancel={() => setConfigOpen(false)}
            onSubmit={saveConfig}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
