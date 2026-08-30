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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState, StatCard, StatusBadge } from '@/components/nurae/bits';
import { BotDTO, Catalog, nuraeApi, ProjectSummary } from '@/lib/nurae-client/api';
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
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard label="Projects" value={stats?.projects ?? '—'} />
        <StatCard label="Active Bots" value={stats?.activeBots ?? '—'} accent="emerald" />
        <StatCard label="Stopped Bots" value={stats?.stoppedBots ?? '—'} />
        <StatCard label="Errors" value={stats?.errors ?? '—'} accent={stats && stats.errors > 0 ? 'red' : 'zinc'} />
      </div>

      <Card className="border-zinc-200">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">Projects</CardTitle>
              <CardDescription>Group bots into projects.</CardDescription>
            </div>
            <Button size="sm" onClick={onGoProjects} className="bg-emerald-600 text-white hover:bg-emerald-700">
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
                <Button onClick={onGoProjects} className="bg-emerald-600 text-white hover:bg-emerald-700">
                  Create project
                </Button>
              }
            />
          ) : (
            <ul className="divide-y divide-zinc-100">
              {projects.map((p) => (
                <li key={p.id}>
                  <button
                    className="flex w-full items-center justify-between rounded-md px-2 py-3 text-left hover:bg-zinc-50"
                    onClick={() => onOpenProject(p.id)}
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-zinc-900">{p.name}</p>
                      <p className="truncate text-xs text-zinc-500">{p.description || 'No description'}</p>
                    </div>
                    <div className="ml-4 flex shrink-0 items-center gap-2 text-xs text-zinc-500">
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
          <h2 className="text-lg font-semibold text-zinc-900">Projects</h2>
          <p className="text-sm text-zinc-500">Each project groups related bots.</p>
        </div>
        <Button onClick={() => setCreateOpen(true)} className="bg-emerald-600 text-white hover:bg-emerald-700" data-testid="create-project">
          Create project
        </Button>
      </div>

      {projects === null ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Card key={i} className="animate-pulse border-zinc-200 p-6">
              <div className="h-4 w-1/3 rounded bg-zinc-200" />
              <div className="mt-3 h-3 w-2/3 rounded bg-zinc-100" />
            </Card>
          ))}
        </div>
      ) : projects.length === 0 ? (
        <EmptyState
          title="No projects yet"
          description="Create your first project to start building AI-powered Telegram bots."
          action={
            <Button onClick={() => setCreateOpen(true)} className="bg-emerald-600 text-white hover:bg-emerald-700">
              Create project
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <Card
              key={p.id}
              className="cursor-pointer border-zinc-200 transition-shadow hover:shadow-md"
              onClick={() => onOpenProject(p.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && onOpenProject(p.id)}
            >
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{p.name}</CardTitle>
                <CardDescription className="line-clamp-2">{p.description || 'No description'}</CardDescription>
              </CardHeader>
              <CardContent className="flex items-center justify-between text-xs text-zinc-500">
                <span>
                  {p.botCount} bot{p.botCount === 1 ? '' : 's'}
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
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
            <Button onClick={handleCreate} disabled={busy} className="bg-emerald-600 text-white hover:bg-emerald-700" data-testid="project-submit">
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
          <Button variant="ghost" size="sm" className="-ml-2 text-zinc-500" onClick={onBack}>
            ← Projects
          </Button>
          <h2 className="truncate text-lg font-semibold text-zinc-900">{project?.name ?? '…'}</h2>
          <p className="truncate text-sm text-zinc-500">{project?.description || 'No description'}</p>
        </div>
        <Button onClick={() => setCreateOpen(true)} className="bg-emerald-600 text-white hover:bg-emerald-700" data-testid="create-bot">
          Create bot
        </Button>
      </div>

      {loaded && bots.length === 0 ? (
        <EmptyState
          title="No bots in this project"
          description="Create an AI-powered Telegram bot: pick a provider, paste the Telegram token, and start it."
          action={
            <Button onClick={() => setCreateOpen(true)} className="bg-emerald-600 text-white hover:bg-emerald-700">
              Create bot
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {bots.map((b) => (
            <Card
              key={b.id}
              className="cursor-pointer border-zinc-200 transition-shadow hover:shadow-md"
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
              <CardContent className="space-y-1 text-xs text-zinc-500">
                <p>
                  <span className="font-medium text-zinc-700">{b.telegramUsername ?? 'Telegram: not verified'}</span>
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
