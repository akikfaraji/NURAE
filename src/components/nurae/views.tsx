'use client';

/**
 * NURAE dashboard — overview & project views.
 */

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState, LoadingRow, Pill, StatCard, StatusBadge } from '@/components/nurae/bits';
import {
  ArrowRightIcon,
  BotIcon,
  CheckIcon,
  GoogleIcon,
  MailIcon,
  RefreshIcon,
  TrashIcon,
} from '@/components/nurae/icons';
import {
  AdminBotDTO,
  BotDTO,
  Catalog,
  CustomerDTO,
  FleetEntry,
  nuraeApi,
  OfficialBotResponse,
  ProjectSummary,
  SiteInfoDTO,
} from '@/lib/nurae-client/api';
import { toast } from 'sonner';

// ---------------------------------------------------------------------------
// Overview (spec §15: Projects / Active Bots / Stopped Bots / Errors)
// ---------------------------------------------------------------------------

export function OverviewView({
  catalog,
  onOpenProject,
  onGoProjects,
}: {
  catalog: Catalog;
  onOpenProject: (id: string) => void;
  onGoProjects: () => void;
}) {
  const [stats, setStats] = useState<{
    projects: number;
    activeBots: number;
    stoppedBots: number;
    errors: number;
    totalBots: number;
    users: number;
  } | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);

  const refresh = useCallback(async () => {
    try {
      const [s, p] = await Promise.all([nuraeApi.stats(), nuraeApi.listProjects()]);
      setStats(s.stats);
      setProjects(p.projects.slice(0, 5));
    } catch {
      /* polling errors are non-fatal */
    }
  }, []);

  useEffect(() => {
    const kick = setTimeout(() => void refresh(), 0);
    const t = setInterval(refresh, 5000);
    return () => {
      clearTimeout(kick);
      clearInterval(t);
    };
  }, [refresh]);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-5">
        <StatCard label="Projects" value={stats?.projects ?? '—'} />
        <StatCard label="Active Bots" value={stats?.activeBots ?? '—'} />
        <StatCard label="Stopped Bots" value={stats?.stoppedBots ?? '—'} />
        <StatCard label="Errors" value={stats?.errors ?? '—'} accent={stats && stats.errors > 0 ? 'red' : 'zinc'} />
        <StatCard label="Customers" value={stats?.users ?? '—'} />
      </div>

      <Card className="border-border">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">Projects</CardTitle>
              <CardDescription>Group bots into projects.</CardDescription>
            </div>
            <Button size="sm" onClick={onGoProjects} >
              Manage projects
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {projects.length === 0 ? (
            <EmptyState
              title="No projects yet"
              description="Create your first project to start building AI-powered Telegram bots."
              action={
                <Button onClick={onGoProjects} >
                  Create project
                </Button>
              }
            />
          ) : (
            <ul className="divide-y divide-border">
              {projects.map((p) => (
                <li key={p.id}>
                  <button
                    className="flex w-full items-center justify-between rounded-md px-2 py-3 text-left hover:bg-muted/50"
                    onClick={() => onOpenProject(p.id)}
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">{p.name}</p>
                      <p className="truncate text-xs text-muted-foreground">{p.description || 'No description'}</p>
                    </div>
                    <div className="ml-4 flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                      <span>
                        {p.activeBots}/{p.botCount} active
                      </span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export function ProjectsView({
  catalog,
  onOpenProject,
}: {
  catalog: Catalog;
  onOpenProject: (id: string) => void;
}) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await nuraeApi.listProjects();
      setProjects(res.projects);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load projects');
      setProjects([]);
    }
  }, []);

  useEffect(() => {
    const kick = setTimeout(() => void refresh(), 0);
    const t = setInterval(refresh, 5000);
    return () => {
      clearTimeout(kick);
      clearInterval(t);
    };
  }, [refresh]);

  const handleCreate = async () => {
    if (!name.trim()) {
      toast.error('Project name is required');
      return;
    }
    setBusy(true);
    try {
      await nuraeApi.createProject(name.trim(), description.trim());
      toast.success('Project created');
      setCreateOpen(false);
      setName('');
      setDescription('');
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create project');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Projects</h2>
          <p className="text-sm text-muted-foreground">Each project groups related bots.</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}  data-testid="create-project">
          Create project
        </Button>
      </div>

      {projects === null ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Card key={i} className="animate-pulse border-border p-6">
              <div className="h-4 w-1/3 rounded bg-muted" />
              <div className="mt-3 h-3 w-2/3 rounded bg-muted" />
            </Card>
          ))}
        </div>
      ) : projects.length === 0 ? (
        <EmptyState
          title="No projects yet"
          description="Create your first project to start building AI-powered Telegram bots."
          action={
            <Button onClick={() => setCreateOpen(true)} >
              Create project
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <Card
              key={p.id}
              className="cursor-pointer border-border transition-shadow hover:shadow-md"
              onClick={() => onOpenProject(p.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && onOpenProject(p.id)}
            >
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{p.name}</CardTitle>
                <CardDescription className="line-clamp-2">{p.description || 'No description'}</CardDescription>
              </CardHeader>
              <CardContent className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {p.botCount} bot{p.botCount === 1 ? '' : 's'}
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-foreground" />
                  {p.activeBots} active
                </span>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create project</DialogTitle>
            <DialogDescription>Projects group your bots and settings.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="project-name">Project name *</Label>
              <Input
                id="project-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={catalog.limits.nameMax}
                placeholder="My Digital Operations"
                data-testid="project-name-input"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="project-desc">Description</Label>
              <Textarea
                id="project-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                placeholder="What is this project about?"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={busy}  data-testid="project-submit">
              {busy ? 'Creating…' : 'Create project'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Project detail (bots of a project)
// ---------------------------------------------------------------------------

export function ProjectView({
  projectId,
  catalog,
  onOpenBot,
  onBack,
}: {
  projectId: string;
  catalog: Catalog;
  onOpenBot: (botId: string) => void;
  onBack: () => void;
}) {
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [bots, setBots] = useState<BotDTO[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await nuraeApi.getProject(projectId);
      setProject(res.project);
      setBots(res.bots);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load project');
    } finally {
      setLoaded(true);
    }
  }, [projectId]);

  useEffect(() => {
    const kick = setTimeout(() => void refresh(), 0);
    const t = setInterval(refresh, 5000);
    return () => {
      clearTimeout(kick);
      clearInterval(t);
    };
  }, [refresh]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground" onClick={onBack}>
            ← Projects
          </Button>
          <h2 className="truncate text-lg font-semibold text-foreground">{project?.name ?? '…'}</h2>
          <p className="truncate text-sm text-muted-foreground">{project?.description || 'No description'}</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}  data-testid="create-bot">
          Create bot
        </Button>
      </div>

      {loaded && bots.length === 0 ? (
        <EmptyState
          title="No bots in this project"
          description="Create an AI-powered Telegram bot: pick a provider, paste the Telegram token, and start it."
          action={
            <Button onClick={() => setCreateOpen(true)} >
              Create bot
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {bots.map((b) => (
            <Card
              key={b.id}
              className="cursor-pointer border-border transition-shadow hover:shadow-md"
              onClick={() => onOpenBot(b.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && onOpenBot(b.id)}
              data-testid={`bot-card-${b.name}`}
            >
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="truncate text-base">{b.name}</CardTitle>
                  <StatusBadge status={b.status} />
                </div>
                <CardDescription className="line-clamp-1">{b.description || 'No description'}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-1 text-xs text-muted-foreground">
                <p>
                  <span className="font-medium text-foreground">{b.telegramUsername ?? 'Telegram: not verified'}</span>
                </p>
                <p>
                  {b.provider} · {b.model}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <CreateBotDialog
        projectId={projectId}
        catalog={catalog}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={async (bot) => {
          setCreateOpen(false);
          await refresh();
          onOpenBot(bot.id);
        }}
      />
    </div>
  );
}

// Create dialog lives here so both Projects and Project view can use it later.
import { BotForm } from '@/components/nurae/bot-form';

export function CreateBotDialog({
  projectId,
  catalog,
  open,
  onOpenChange,
  onCreated,
}: {
  projectId: string;
  catalog: Catalog;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (bot: BotDTO) => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Create AI Telegram bot</DialogTitle>
          <DialogDescription>
            Configure the identity, AI provider, and behavior. You can change everything later.
          </DialogDescription>
        </DialogHeader>
        <BotForm
          catalog={catalog}
          submitLabel="Create bot"
          busy={busy}
          serverErrors={serverErrors}
          onCancel={() => onOpenChange(false)}
          onSubmit={async (input) => {
            setBusy(true);
            setServerErrors({});
            try {
              const res = await nuraeApi.createBot(projectId, input);
              toast.success(`Bot "${res.bot.name}" created`);
              await onCreated(res.bot);
            } catch (err) {
              const e = err as { message?: string; fields?: Record<string, string> };
              setServerErrors(e.fields ?? { _form: e.message ?? 'Failed to create bot' });
              toast.error(e.message ?? 'Failed to create bot');
            } finally {
              setBusy(false);
            }
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Official NURAE bot card (overview) — "fill in the keys and run"
// ---------------------------------------------------------------------------

export function OfficialBotCard({
  onOpenBot,
  catalog,
}: {
  onOpenBot: (botId: string) => void;
  catalog: Catalog | null;
}) {
  const [data, setData] = useState<OfficialBotResponse | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [configErrors, setConfigErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setData(await nuraeApi.officialBot());
    } catch {
      /* non-fatal */
    }
  }, []);

  useEffect(() => {
    const kick = setTimeout(() => void refresh(), 0);
    const t = setInterval(refresh, 10000);
    return () => {
      clearTimeout(kick);
      clearInterval(t);
    };
  }, [refresh]);

  const saveConfig = async (input: Parameters<typeof nuraeApi.updateConfig>[1]) => {
    if (!data?.bot) return;
    setBusy('config');
    setConfigErrors({});
    try {
      await nuraeApi.updateConfig(data.bot.id, input);
      setConfigOpen(false);
      toast.success('Official bot configuration saved', {
        description: 'The web chat uses it immediately; restart the bot to apply it on Telegram.',
      });
      await refresh();
    } catch (err) {
      const e = err as { message?: string; fields?: Record<string, string> };
      setConfigErrors(e.fields ?? { _form: e.message ?? 'Failed to save configuration' });
      toast.error(e.message ?? 'Failed to save configuration');
    } finally {
      setBusy(null);
    }
  };

  const syncPrompt = async () => {
    if (!data?.bot) return;
    setBusy('prompt');
    try {
      await nuraeApi.syncOfficialPrompt();
      toast.success('System prompt rebuilt from the current site settings');
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to rebuild the prompt');
    } finally {
      setBusy(null);
    }
  };

  const o = data?.official;
  const stepsDone = o ? (o.hasApiKey ? 1 : 0) + (o.hasTelegramToken ? 1 : 0) : 0;

  return (
    <Card className="border-border">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-md bg-foreground text-background">
              <BotIcon className="h-5 w-5" />
            </span>
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                NURAE CS Bot
                <Pill>Official</Pill>
              </CardTitle>
              <CardDescription>
                The built-in customer-support bot for your site — fill in the keys and run it.
              </CardDescription>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {catalog && data?.bot && (
              <Button size="sm" variant="outline" onClick={() => setConfigOpen(true)}>
                Configure keys &amp; prompt
              </Button>
            )}
            {o?.botId && (
              <Button size="sm" className="gap-2" onClick={() => onOpenBot(o.botId!)}>
                {o.ready ? (o.status === 'running' ? 'Manage' : 'Open & start') : 'Open bot'}
                <ArrowRightIcon className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-3">
          <KeyStep
            label="AI provider key"
            done={Boolean(o?.hasApiKey)}
            fallback={Boolean(o && !o.hasApiKey && o.ready)}
            doneText={o?.hasApiKey ? 'Stored (encrypted)' : ''}
            fallbackText="Env fallback active"
            pendingText="Missing — chat disabled"
          />
          <KeyStep
            label="Telegram bot token"
            done={Boolean(o?.hasTelegramToken)}
            doneText={o?.telegramUsername ?? (o?.hasTelegramToken ? 'Stored (encrypted)' : '')}
            fallback={false}
            pendingText="Optional — web chat works without it"
          />
          <KeyStep
            label="Runtime"
            done={o?.status === 'running'}
            doneText={`Running on ${o?.transport ?? 'telegram'}`}
            fallback={false}
            pendingText={o?.status ? o.status : 'Not started yet'}
          />
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            Setup: {stepsDone}/2 keys · customers chat on your site with just the AI key; add a token from @BotFather to run it on Telegram.
          </p>
          {data?.bot && (
            <button
              type="button"
              onClick={syncPrompt}
              disabled={busy !== null}
              className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
              title="Rebuild the bot's system prompt from the current site settings (site name, support email, welcome message)"
            >
              {busy === 'prompt' ? 'Rebuilding…' : 'Reset prompt to official'}
            </button>
          )}
        </div>
      </CardContent>

      {catalog && data?.bot && (
        <Dialog open={configOpen} onOpenChange={setConfigOpen}>
          <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
            <DialogHeader>
              <DialogTitle>Configure the official bot</DialogTitle>
              <DialogDescription>
                Paste the AI key (and optionally a Telegram token from @BotFather), tune the prompt. Secrets are stored
                encrypted and never shown again.
              </DialogDescription>
            </DialogHeader>
            <BotForm
              catalog={catalog}
              bot={data.bot}
              submitLabel="Save configuration"
              busy={busy === 'config'}
              serverErrors={configErrors}
              onCancel={() => setConfigOpen(false)}
              onSubmit={saveConfig}
            />
          </DialogContent>
        </Dialog>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Official NURAE fleet (overview) — the built-in promotion bots, ready to run
// ---------------------------------------------------------------------------

export function OfficialFleetCard({ onOpenBot }: { onOpenBot: (botId: string) => void }) {
  const [fleet, setFleet] = useState<FleetEntry[] | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await nuraeApi.officialBot();
      setFleet(data.fleet ?? []);
    } catch {
      /* non-fatal — retried on the interval */
    }
  }, []);

  useEffect(() => {
    const kick = setTimeout(() => void refresh(), 300);
    const t = setInterval(refresh, 15000);
    return () => {
      clearTimeout(kick);
      clearInterval(t);
    };
  }, [refresh]);

  return (
    <Card className="border-border">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              NURAE bot fleet
              <Pill>Official</Pill>
            </CardTitle>
            <CardDescription>
              The five built-in NURAE promotion bots, seeded for this instance — add a token from @BotFather to each
              and start them as your own official bots.
            </CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={refresh} className="gap-1.5">
            <RefreshIcon className="h-3.5 w-3.5" /> Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {(fleet ?? []).map((entry) => {
          const needsToken = !entry.hasTelegramToken;
          const stateLabel = entry.status === 'running'
            ? `Running${entry.transport ? ` (${entry.transport})` : ''}`
            : needsToken
              ? 'Needs token'
              : 'Ready to start';
          return (
            <div
              key={entry.templateId}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-border px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-foreground">{entry.name}</span>
                  <Pill>{entry.category}</Pill>
                </div>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">{entry.tagline}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-1 text-xs text-foreground"
                  title={needsToken ? 'Paste a @BotFather token in the bot page' : undefined}
                >
                  <span
                    className={
                      'inline-block h-1.5 w-1.5 rounded-full ' +
                      (entry.status === 'running'
                        ? 'animate-pulse bg-foreground'
                        : needsToken
                          ? 'bg-muted-foreground'
                          : 'bg-muted-foreground/60')
                    }
                  />
                  {stateLabel}
                </span>
                {entry.telegramUsername && (
                  <span className="hidden font-mono text-xs text-muted-foreground sm:inline">
                    @{entry.telegramUsername}
                  </span>
                )}
                {entry.botId && (
                  <Button size="sm" variant="outline" className="gap-1.5" onClick={() => onOpenBot(entry.botId!)}>
                    {needsToken ? 'Add token' : 'Manage'} <ArrowRightIcon className="h-3 w-3" />
                  </Button>
                )}
              </div>
            </div>
          );
        })}
        {fleet && fleet.length === 0 && (
          <p className="text-xs text-muted-foreground">Fleet seeding pending — reload the dashboard.</p>
        )}
        {!fleet && <LoadingRow label="Loading fleet…" />}
      </CardContent>
    </Card>
  );
}

function KeyStep({
  label,
  done,
  fallback,
  doneText,
  fallbackText,
  pendingText,
}: {
  label: string;
  done: boolean;
  fallback: boolean;
  doneText: string;
  fallbackText?: string;
  pendingText: string;
}) {
  return (
    <div className="flex items-start gap-2.5 rounded-md border border-border bg-muted/30 px-3 py-2.5">
      <span
        className={
          'mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ' +
          (done || fallback ? 'border-transparent bg-foreground text-background' : 'border-border text-muted-foreground')
        }
      >
        {done || fallback ? <CheckIcon className="h-2.5 w-2.5" /> : <span className="h-1 w-1 rounded-full bg-current" />}
      </span>
      <div className="min-w-0">
        <p className="font-medium text-foreground">{label}</p>
        <p className="truncate text-muted-foreground">{done ? doneText : fallback ? (fallbackText ?? 'Fallback active') : pendingText}</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Customers — every account on the platform
// ---------------------------------------------------------------------------

export function CustomersView({ onBack }: { onBack: () => void }) {
  const [customers, setCustomers] = useState<CustomerDTO[] | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await nuraeApi.listCustomers();
      setCustomers(r.customers);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load customers');
      setCustomers([]);
    }
  }, []);

  useEffect(() => {
    const kick = setTimeout(() => void refresh(), 0);
    return () => clearTimeout(kick);
  }, [refresh]);

  const remove = async (id: string) => {
    setConfirmId(null);
    try {
      await nuraeApi.deleteCustomer(id);
      toast.success('Customer deleted');
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground sm:text-2xl">Customers</h1>
          <p className="text-sm text-muted-foreground">Everyone who signed up on your site.</p>
        </div>
        <Button variant="ghost" size="sm" onClick={onBack}>
          Back to dashboard
        </Button>
      </div>

      <Card className="border-border">
        <CardContent className="p-0">
          {customers === null ? (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">Loading customers…</div>
          ) : customers.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">
              No customers yet — they will appear here as soon as someone signs up at <span className="font-mono">/</span>.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Customer</TableHead>
                  <TableHead>Sign-up</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Chats</TableHead>
                  <TableHead className="text-right">Bots</TableHead>
                  <TableHead className="text-right">Sessions</TableHead>
                  <TableHead>Joined</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {customers.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">{c.name}</p>
                        <p className="truncate text-xs text-muted-foreground">{c.email}</p>
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                        {c.signupMethod === 'google' ? <GoogleIcon className="h-3.5 w-3.5" /> : <MailIcon className="h-3.5 w-3.5" />}
                        {c.signupMethod === 'google' ? 'Google' : 'Email'}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span
                        className={
                          'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] ' +
                          (c.emailVerified
                            ? 'border-border bg-muted text-foreground'
                            : 'border-destructive/40 bg-destructive/10 text-destructive')
                        }
                      >
                        <span className={'h-1.5 w-1.5 rounded-full ' + (c.emailVerified ? 'bg-foreground' : 'bg-destructive')} />
                        {c.emailVerified ? 'Verified' : 'Unverified'}
                      </span>
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums text-foreground">{c.chatMessages}</TableCell>
                    <TableCell className="text-right text-sm tabular-nums text-foreground">{c.botCount}</TableCell>
                    <TableCell className="text-right text-sm tabular-nums text-foreground">{c.activeSessions}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {new Date(c.createdAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell>
                      <AlertDialog open={confirmId === c.id} onOpenChange={(open) => setConfirmId(open ? c.id : null)}>
                        <AlertDialogTrigger asChild>
                          <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive" aria-label={`Delete ${c.email}`}>
                            <TrashIcon className="h-4 w-4" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete customer?</AlertDialogTitle>
                            <AlertDialogDescription>
                              This permanently removes {c.email} with their {c.botCount} bot(s) (stopped and deleted),
                              sessions, verification state, wallet history and support chat history. This cannot be undone.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={() => void remove(c.id)}>Delete</AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bots monitor — EVERY bot on the platform (official + customer-owned), with
// lifecycle override (start/stop/restart) and one-click log access.
// ---------------------------------------------------------------------------

export function AdminBotsView() {
  const [bots, setBots] = useState<AdminBotDTO[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const refresh = useCallback(async () => {
    try {
      const r = await nuraeApi.listAdminBots();
      setBots(r.bots);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load bots');
      setBots([]);
    }
  }, []);

  useEffect(() => {
    const kick = setTimeout(() => void refresh(), 0);
    return () => clearTimeout(kick);
  }, [refresh]);

  const lifecycle = async (id: string, action: 'start' | 'stop' | 'restart') => {
    setBusyId(id + action);
    try {
      if (action === 'start') await nuraeApi.startBot(id);
      else if (action === 'stop') await nuraeApi.stopBot(id);
      else await nuraeApi.restartBot(id);
      toast.success(`Bot ${action === 'start' ? 'started' : action === 'stop' ? 'stopped' : 'restarted'}`);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `${action} failed`);
    } finally {
      setBusyId(null);
    }
  };

  const visible = (bots ?? []).filter((b) => {
    const q = filter.trim().toLowerCase();
    if (!q) return true;
    return (
      b.name.toLowerCase().includes(q) ||
      (b.owner.email ?? '').toLowerCase().includes(q) ||
      (b.telegramUsername ?? '').toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-foreground sm:text-2xl">Bots</h1>
          <p className="text-sm text-muted-foreground">
            Every bot on this platform — official fleet and customer builds. You can stop, start or restart any of them.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by name, owner or @username"
            className="h-9 w-64"
          />
          <Button variant="outline" size="sm" onClick={() => void refresh()}>
            <RefreshIcon className="h-3.5 w-3.5" /> Refresh
          </Button>
        </div>
      </div>

      <Card className="border-border">
        <CardContent className="p-0">
          {bots === null ? (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">Loading bots…</div>
          ) : visible.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">
              {filter ? 'No bots match that filter.' : 'No bots yet.'}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Bot</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Audience</TableHead>
                  <TableHead className="text-right">Messages</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead className="text-right">Controls</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((b) => (
                  <TableRow key={b.id}>
                    <TableCell>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">{b.name}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {b.telegramUsername ? `${b.telegramUsername} · ` : ''}
                          {b.transport ?? 'never started'}
                        </p>
                      </div>
                    </TableCell>
                    <TableCell>
                      <span
                        className={
                          'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] ' +
                          (b.owner.kind === 'platform'
                            ? 'border-border bg-muted text-foreground'
                            : 'border-border text-muted-foreground')
                        }
                      >
                        {b.owner.kind === 'platform' ? 'Official' : b.owner.email ?? 'customer'}
                      </span>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={b.status} />
                      {b.statusDetail && (
                        <p className="mt-1 max-w-56 truncate text-[11px] text-muted-foreground" title={b.statusDetail}>
                          {b.statusDetail}
                        </p>
                      )}
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums text-foreground">{b.audience}</TableCell>
                    <TableCell className="text-right text-sm tabular-nums text-foreground">{b.messages}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {new Date(b.updatedAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        {b.status === 'running' ? (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busyId === b.id + 'stop'}
                              onClick={() => void lifecycle(b.id, 'stop')}
                            >
                              Stop
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busyId === b.id + 'restart'}
                              onClick={() => void lifecycle(b.id, 'restart')}
                            >
                              Restart
                            </Button>
                          </>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busyId === b.id + 'start'}
                            onClick={() => void lifecycle(b.id, 'start')}
                          >
                            Start
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Site settings — feeds the public site and the official bot's knowledge
// ---------------------------------------------------------------------------

export function SiteSettingsView({ onBack }: { onBack: () => void }) {
  const [form, setForm] = useState<SiteInfoDTO | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const r = await nuraeApi.getSettings();
        setForm(r.settings);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to load settings');
      }
    })();
  }, []);

  if (!form) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold text-foreground sm:text-2xl">Site settings</h1>
        </div>
        <div className="text-sm text-muted-foreground">Loading settings…</div>
      </div>
    );
  }

  const set = (patch: Partial<SiteInfoDTO>) => setForm({ ...form, ...patch });

  const save = async () => {
    setBusy(true);
    try {
      const r = await nuraeApi.saveSettings(form);
      setForm(r.settings);
      toast.success('Site settings saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground sm:text-2xl">Site settings</h1>
          <p className="text-sm text-muted-foreground">
            Shown on the public site and baked into the official bot&apos;s knowledge.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onBack}>
          Back to dashboard
        </Button>
      </div>

      <Card className="border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Public details</CardTitle>
          <CardDescription>Every field can be reset to its default by clearing it.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="set-site-name">Site name</Label>
              <Input id="set-site-name" value={form.siteName} maxLength={60} onChange={(e) => set({ siteName: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="set-telegram">Official Telegram handle</Label>
              <Input
                id="set-telegram"
                placeholder="@your_bot"
                value={form.telegramHandle}
                maxLength={60}
                onChange={(e) => set({ telegramHandle: e.target.value })}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="set-tagline">Tagline (hero text)</Label>
            <Input id="set-tagline" value={form.tagline} maxLength={200} onChange={(e) => set({ tagline: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="set-support-email">Support email</Label>
            <Input
              id="set-support-email"
              type="email"
              placeholder="support@yourdomain.com"
              value={form.supportEmail}
              onChange={(e) => set({ supportEmail: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="set-welcome">Support bot welcome message</Label>
            <Textarea
              id="set-welcome"
              rows={3}
              maxLength={500}
              value={form.welcomeMessage}
              onChange={(e) => set({ welcomeMessage: e.target.value })}
            />
          </div>
          <div className="flex items-center justify-between border-t border-border pt-4">
            <p className="text-xs text-muted-foreground">
              Changing the knowledge of the already-seeded bot? Edit its system prompt on the bot page.
            </p>
            <Button onClick={save} disabled={busy}>
              {busy ? 'Saving…' : 'Save settings'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
