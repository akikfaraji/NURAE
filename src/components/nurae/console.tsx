'use client';

/**
 * NURAE admin console — application shell (lives under /admin/*).
 * URL-driven sections: /admin/dashboard · /admin/bots · /admin/customers ·
 * /admin/agent · /admin/settings. Deep views (projects → project → bot)
 * keep their section's URL. The public site (landing + NURAE CS chat) lives at `/`.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { OverviewView, ProjectView, ProjectsView, CustomersView, AdminBotsView, SiteSettingsView, OfficialBotCard, OfficialFleetCard } from '@/components/nurae/views';
import { BotView } from '@/components/nurae/bot-view';
import { OperatorAgentView } from '@/components/nurae/operator-view';
import { Catalog, nuraeApi } from '@/lib/nurae-client/api';
import { NURAE_VERSION } from '@/lib/nurae/version';
import { LoadingRow } from '@/components/nurae/bits';
import { toast } from 'sonner';

type View =
  | { type: 'overview' }
  | { type: 'projects' }
  | { type: 'project'; id: string }
  | { type: 'bot'; id: string; projectId: string }
  | { type: 'bots' }
  | { type: 'customers' }
  | { type: 'agent' }
  | { type: 'settings' };

type Section = 'dashboard' | 'bots' | 'projects' | 'customers' | 'agent' | 'settings';

/** The URL section a view belongs to (deep views ride their parent section). */
function sectionOf(view: View): Section {
  switch (view.type) {
    case 'overview':
      return 'dashboard';
    case 'bots':
      return 'bots';
    case 'customers':
      return 'customers';
    case 'agent':
      return 'agent';
    case 'settings':
      return 'settings';
    default:
      return 'projects';
  }
}

function viewFromSection(section: string | undefined): View {
  switch (section) {
    case 'bots':
      return { type: 'bots' };
    case 'customers':
      return { type: 'customers' };
    case 'agent':
      return { type: 'agent' };
    case 'settings':
      return { type: 'settings' };
    case 'projects':
      return { type: 'projects' };
    default:
      return { type: 'overview' };
  }
}

export function NuraeConsole({ initialSection }: { initialSection?: string }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [authed, setAuthed] = useState(true);
  const [checked, setChecked] = useState(false);
  const [view, setView] = useState<View>(() => viewFromSection(initialSection));
  const [coreUp, setCoreUp] = useState<boolean | null>(null);

  // Every navigation keeps the URL honest (/admin/<section>) without a router
  // round-trip — deep views (project/bot) map back to their section.
  const go = useCallback((next: View) => {
    setView(next);
    try {
      const url = `/admin/${sectionOf(next)}`;
      if (window.location.pathname !== url) window.history.replaceState(null, '', url);
    } catch {
      /* SSR-ish edge — URL sync is best-effort */
    }
  }, []);

  // Load catalog + auth state. Catalog lives behind the auth guard, so fetch
  // it only once authenticated.
  const loadCatalog = useCallback(async () => {
    try {
      const c = await nuraeApi.catalog();
      setCatalog(c);
    } catch {
      /* catalog unavailable until auth passes */
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const s = await nuraeApi.authStatus();
        setAuthRequired(s.authRequired);
        setAuthed(s.authenticated);
        if (s.authenticated) {
          await loadCatalog();
          // Core health probe (non-blocking informational).
          nuraeApi
            .health()
            .then(() => setCoreUp(true))
            .catch(() => setCoreUp(false));
        }
      } catch {
        setAuthed(true); // fail-open to the UI; API calls will surface errors
      } finally {
        setChecked(true);
      }
    })();
  }, [loadCatalog]);

  const openProject = async (id: string) => {
    go({ type: 'project', id });
  };

  const openBotById = async (botId: string) => {
    // The official bot card knows the bot id but not its project — resolve it.
    try {
      const { bot } = await nuraeApi.getBot(botId);
      go({ type: 'bot', id: bot.id, projectId: bot.projectId });
    } catch {
      go({ type: 'projects' });
    }
  };

  if (!checked) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="text-sm text-muted-foreground">Loading NURAE console…</div>
      </div>
    );
  }

  if (authRequired && !authed) {
    return <LoginGate onAuthenticated={async () => { setAuthed(true); await loadCatalog(); }} />;
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="sticky top-0 z-20 shrink-0 border-b border-border/60 bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-12 max-w-6xl items-center gap-4 px-4 sm:px-6">
          <button
            className="flex shrink-0 items-baseline gap-2 text-left"
            onClick={() => go({ type: 'overview' })}
            aria-label="Go to dashboard"
          >
            <span className="text-sm font-semibold tracking-wide text-foreground">NURAE Admin</span>
            <span className="hidden font-mono text-[11px] text-muted-foreground sm:inline">{NURAE_VERSION}</span>
          </button>
          <nav
            className="flex items-center gap-5 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            aria-label="Admin"
          >
            {([
              ['overview', 'Dashboard'],
              ['bots', 'Bots'],
              ['projects', 'Projects'],
              ['agent', 'Agent'],
              ['customers', 'Customers'],
              ['settings', 'Site'],
            ] as const).map(([key, label]) => {
              const active =
                key === 'overview'
                  ? view.type === 'overview'
                  : key === 'projects'
                    ? view.type === 'projects' || view.type === 'project'
                    : view.type === key;
              return (
                <button
                  key={key}
                  onClick={() => go(key === 'overview' ? { type: 'overview' } : ({ type: key } as View))}
                  aria-current={active ? 'page' : undefined}
                  className={
                    'shrink-0 text-xs transition-colors sm:text-[13px] ' +
                    (active ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')
                  }
                >
                  {label}
                </button>
              );
            })}
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-3">
            <span
              className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex"
              title={coreUp ? 'NURAE core reachable' : 'NURAE core unreachable — API calls will fail'}
            >
              <span
                className={
                  'inline-block h-1.5 w-1.5 rounded-full ' +
                  (coreUp === null ? 'bg-muted-foreground/40' : coreUp ? 'bg-foreground' : 'bg-destructive')
                }
              />
              {coreUp === null ? '…' : coreUp ? 'Core online' : 'Core offline'}
            </span>
            <Link
              href="/"
              className="text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              View site
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
        {view.type === 'overview' && (
          <div className="mb-6">
            <h1 className="text-xl font-semibold text-foreground sm:text-2xl">Dashboard</h1>
            <p className="text-sm text-muted-foreground">
              The official bot, the built-in fleet, and the state of the platform — {NURAE_VERSION}.
            </p>
            <div className="mt-6 space-y-4">
              <OfficialBotCard onOpenBot={openBotById} catalog={catalog} />
              <OfficialFleetCard onOpenBot={openBotById} />
            </div>
          </div>
        )}
        {view.type === 'customers' ? (
          <CustomersView />
        ) : view.type === 'bots' ? (
          <AdminBotsView />
        ) : view.type === 'agent' ? (
          <OperatorAgentView />
        ) : view.type === 'settings' ? (
          <SiteSettingsView />
        ) : view.type === 'bot' && !catalog ? (
          // The config dialog needs the provider catalog — never render the
          // bot view (or its forms) with a null catalog.
          <LoadingRow label="Loading console data…" />
        ) : !catalog ? (
          <LoadingRow label="Loading console data…" />
        ) : view.type === 'overview' ? (
          <OverviewView
            catalog={catalog!}
            onOpenProject={openProject}
            onGoProjects={() => go({ type: 'projects' })}
          />
        ) : view.type === 'projects' ? (
          <ProjectsView catalog={catalog!} onOpenProject={openProject} />
        ) : view.type === 'project' ? (
          <ProjectView
            projectId={view.id}
            catalog={catalog!}
            onOpenBot={(botId) => go({ type: 'bot', id: botId, projectId: view.id })}
            onBack={() => go({ type: 'projects' })}
          />
        ) : (
          <BotView
            botId={view.id}
            catalog={catalog!}
            onBack={() => setView({ type: 'project', id: view.projectId })}
          />
        )}
      </main>

      <footer className="mt-auto border-t border-border/60 bg-background">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-4 text-[11px] text-muted-foreground sm:px-6">
          <span>
            NURAE <span className="font-mono">{NURAE_VERSION}</span>
          </span>
          <span>FRAZIYM TECH &amp; AI</span>
        </div>
      </footer>
    </div>
  );
}

function LoginGate({ onAuthenticated }: { onAuthenticated: () => void | Promise<void> }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim()) return;
    setBusy(true);
    try {
      await nuraeApi.login(token.trim());
      toast.success('Welcome back');
      await onAuthenticated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-xs">
        <h1 className="text-lg font-medium text-foreground">NURAE Admin</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          Enter the admin token to continue.
        </p>
        <form onSubmit={submit} className="mt-6 space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="admin-token" className="sr-only">Admin token</Label>
            <Input
              id="admin-token"
              type="password"
              autoComplete="current-password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Admin token"
              autoFocus
            />
          </div>
          <Button type="submit" className="w-full" size="sm" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </div>
    </div>
  );
}
