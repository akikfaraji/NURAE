'use client';

/**
 * NURAE console — application shell.
 * Single-page dashboard: auth gate → overview → projects → project → bot.
 * (The deployment exposes only the `/` route; navigation is client-side.)
 */

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { OverviewView, ProjectView, ProjectsView } from '@/components/nurae/views';
import { BotView } from '@/components/nurae/bot-view';
import { Catalog, nuraeApi } from '@/lib/nurae-client/api';
import { NURAE_VERSION } from '@/lib/nurae/version';
import { toast } from 'sonner';

type View =
  | { type: 'overview' }
  | { type: 'projects' }
  | { type: 'project'; id: string }
  | { type: 'bot'; id: string; projectId: string };

export function NuraeConsole() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [authed, setAuthed] = useState(true);
  const [checked, setChecked] = useState(false);
  const [view, setView] = useState<View>({ type: 'overview' });
  const [coreUp, setCoreUp] = useState<boolean | null>(null);

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
    setView({ type: 'project', id });
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
    <div className="flex min-h-screen flex-col bg-muted/50">
      <header className="sticky top-0 z-20 border-b border-border bg-background/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <button
            className="flex items-center gap-3 text-left"
            onClick={() => setView({ type: 'overview' })}
            aria-label="Go to overview"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-md bg-foreground font-bold text-background">
              N
            </span>
            <span>
              <span className="block text-sm font-semibold tracking-wide text-foreground">
                NURAE <span className="font-mono text-xs text-muted-foreground">{NURAE_VERSION}</span>
              </span>
              <span className="block text-[11px] uppercase tracking-widest text-muted-foreground">FRAZIYM TECH &amp; AI</span>
            </span>
          </button>
          <nav className="flex items-center gap-1" aria-label="Main">
            <Button
              variant="ghost"
              size="sm"
              className={view.type === 'overview' ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground'}
              onClick={() => setView({ type: 'overview' })}
            >
              Dashboard
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={view.type === 'projects' || view.type === 'project' ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground'}
              onClick={() => setView({ type: 'projects' })}
            >
              Projects
            </Button>
            <span
              className={
                'ml-2 hidden items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs sm:inline-flex ' +
                (coreUp === null
                  ? 'border-border text-muted-foreground'
                  : coreUp
                    ? 'border-border bg-muted text-foreground'
                    : 'border-destructive/40 bg-destructive/10 text-destructive')
              }
              title={coreUp ? 'NURAE core reachable' : 'NURAE core unreachable — API calls will fail'}
            >
              <span
                className={
                  'inline-block h-1.5 w-1.5 rounded-full ' +
                  (coreUp === null ? 'bg-muted-foreground/40' : coreUp ? 'bg-foreground' : 'bg-destructive')
                }
              />
              Core {coreUp === null ? '…' : coreUp ? 'online' : 'offline'}
            </span>
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
        {view.type === 'overview' && (
          <div className="mb-6">
            <h1 className="text-xl font-semibold text-foreground sm:text-2xl">Autonomous Digital Operations</h1>
            <p className="text-sm text-muted-foreground">
              Create and operate AI-powered Telegram bots. This is the {NURAE_VERSION} release.
            </p>
          </div>
        )}
        {!catalog && view.type !== 'bot' ? (
          <div className="text-sm text-muted-foreground">Loading console data…</div>
        ) : view.type === 'overview' ? (
          <OverviewView
            catalog={catalog!}
            onOpenProject={openProject}
            onGoProjects={() => setView({ type: 'projects' })}
          />
        ) : view.type === 'projects' ? (
          <ProjectsView catalog={catalog!} onOpenProject={openProject} />
        ) : view.type === 'project' ? (
          <ProjectView
            projectId={view.id}
            catalog={catalog!}
            onOpenBot={(botId) => setView({ type: 'bot', id: botId, projectId: view.id })}
            onBack={() => setView({ type: 'projects' })}
          />
        ) : (
          <BotView
            botId={view.id}
            catalog={catalog!}
            onBack={() => setView({ type: 'project', id: view.projectId })}
          />
        )}
      </main>

      <footer className="mt-auto border-t border-border bg-background">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-4 text-xs text-muted-foreground sm:px-6">
          <span>
            NURAE <span className="font-mono">{NURAE_VERSION}</span> — Autonomous Digital Operations System
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
    <div className="flex min-h-screen items-center justify-center bg-muted/50 px-4">
      <Card className="w-full max-w-sm border-border">
        <CardHeader className="text-center">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg bg-foreground text-xl font-bold text-background">
            N
          </span>
          <CardTitle className="mt-2 text-lg">
            NURAE <span className="font-mono text-xs text-muted-foreground">{NURAE_VERSION}</span>
          </CardTitle>
          <CardDescription>Enter the admin token to access the console.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="admin-token">Admin token</Label>
              <Input
                id="admin-token"
                type="password"
                autoComplete="current-password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="NURAE_ADMIN_TOKEN"
              />
            </div>
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
          <p className="mt-4 text-center text-xs text-muted-foreground">FRAZIYM TECH &amp; AI</p>
        </CardContent>
      </Card>
    </div>
  );
}
