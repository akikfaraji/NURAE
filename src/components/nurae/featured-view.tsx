'use client';

/**
 * NURAE — /featured: one quiet page, no dashboard energy.
 * Features the NURAE CS conversation and a few curated starting points.
 * Picking a question opens /chats with it preloaded (sessionStorage handoff).
 */

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { SiteFooter, SiteHeader, SiteSplash, useSiteUser } from '@/components/nurae/site-shell';

const FEATURED_QUESTIONS = [
  'What can NURAE do?',
  'How do I connect my own Telegram bot token?',
  'Explain inline keyboards with an example.',
];

export function FeaturedView() {
  const { user, checked, signOut } = useSiteUser();

  if (!checked) return <SiteSplash />;

  const pick = (text: string) => {
    try {
      sessionStorage.setItem('nurae:prefill', text);
    } catch {
      /* private mode — the plain link still works */
    }
  };

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <SiteHeader user={user} onSignOut={signOut} variant={user ? 'app' : 'public'} />
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-14 sm:px-6">
        <p className="text-[11px] uppercase tracking-widest text-muted-foreground">Featured</p>
        <h1 className="mt-3 text-2xl font-medium tracking-tight text-foreground">
          The NURAE CS conversation
        </h1>
        <p className="mt-3 max-w-lg text-sm leading-relaxed text-muted-foreground">
          The official NURAE assistant — the same one that answers here — talks through what the
          platform can do, how bots are built, and what your agents can take off your hands.
          It renders markdown, remembers context, and hands real work to the Bot Builder.
        </p>

        <div className="mt-8 border-t border-border/60">
          {FEATURED_QUESTIONS.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => pick(q)}
              className="group flex w-full items-center justify-between gap-4 border-b border-border/60 py-3 text-left"
            >
              <span className="text-sm text-muted-foreground transition-colors group-hover:text-foreground">{q}</span>
              <span className="text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">→</span>
            </button>
          ))}
        </div>

        <Button size="sm" asChild className="mt-8">
          <Link href="/chats">Open the conversation {user ? '' : '(sign in first)'}</Link>
        </Button>
      </main>
      {!user && <SiteFooter siteName="NURAE" />}
    </div>
  );
}
