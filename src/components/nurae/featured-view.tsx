'use client';

/**
 * NURAE — /featured: one quiet page, no dashboard energy.
 * Features the NURAE CS conversation and a few curated starting points.
 * Picking a question opens /chats with it preloaded (sessionStorage handoff).
 *
 * V4 depth pass: PageContainer (marketing light); the question list became
 * three Glass cards with mono ordinals — same copy, same handoff.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { SiteFooter, SiteHeader, SiteSplash, useSiteUser } from '@/components/nurae/site-shell';
import { PageContainer } from '@/components/nurae/depth';

const FEATURED_QUESTIONS = [
  'What can NURAE do?',
  'How do I connect my own Telegram bot token?',
  'Explain inline keyboards with an example.',
];

export function FeaturedView() {
  const router = useRouter();
  const { user, checked, signOut } = useSiteUser();

  if (!checked) return <SiteSplash />;

  // The handoff contract: the question is stored, the user is MOVED to the
  // conversation. A silent sessionStorage write with no navigation reads as a
  // dead button — the navigation IS the feedback.
  const pick = (text: string) => {
    try {
      sessionStorage.setItem('nurae:prefill', text);
    } catch {
      /* private mode — navigate anyway; the chat is still one tap away */
    }
    router.push('/chats');
  };

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader user={user} onSignOut={signOut} variant={user ? 'app' : 'public'} />
      <PageContainer
        variant="marketing"
        kicker="Featured"
        title="The NURAE CS conversation"
        description="The official NURAE assistant — the same one that answers here — talks through what the platform can do, how bots are built, and what your agents can take off your hands. It renders markdown, remembers context, and hands real work to the Bot Builder."
        className="min-h-0 flex-1"
      >
        <div className="mt-8 grid gap-3 sm:grid-cols-3">
          {FEATURED_QUESTIONS.map((q, i) => (
            <button
              key={q}
              type="button"
              onClick={() => pick(q)}
              className="n-glass n-press group flex flex-col justify-between gap-6 p-4 text-left"
            >
              <span className="flex items-center justify-between">
                <span className="n-num text-[10.5px] text-muted-foreground/70">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <span
                  aria-hidden
                  className="text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                >
                  →
                </span>
              </span>
              <span className="text-[13px] leading-relaxed text-muted-foreground transition-colors group-hover:text-foreground">
                {q}
              </span>
            </button>
          ))}
        </div>

        <Button size="sm" asChild className="mt-8">
          <Link href="/chats">Open the conversation {user ? '' : '(sign in first)'}</Link>
        </Button>
      </PageContainer>
      {!user && <SiteFooter siteName="NURAE" />}
    </div>
  );
}
