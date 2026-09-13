'use client';

/**
 * NURAE — shared chrome for the public user site (all pages).
 *
 * ONE header for the whole site: brand, page navigation (Home · Chat ·
 * Help · About) and the account area (email + Sign out when signed in).
 * Keeping the account controls here is what de-duplicates the "two heads"
 * look — page-level cards (e.g. the chat) stay toolbars, not headers.
 *
 * Deliberately NO link to /admin: the operator console is not part of the
 * customer site; the owner reaches it by typing the URL directly.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { SessionUserDTO, nuraeApi } from '@/lib/nurae-client/api';
import { NURAE_VERSION } from '@/lib/nurae/version';

const NAV = [
  { href: '/', label: 'Home' },
  { href: '/chat', label: 'Chat' },
  { href: '/help', label: 'Help' },
  { href: '/about', label: 'About' },
] as const;

export function useSiteUser() {
  const [user, setUser] = useState<SessionUserDTO | null>(null);
  const [checked, setChecked] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const me = await nuraeApi.me();
      setUser(me.user);
      return me.user;
    } catch {
      setUser(null);
      return null;
    } finally {
      setChecked(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signOut = useCallback(async () => {
    try {
      await nuraeApi.userLogout();
    } finally {
      setUser(null);
    }
  }, []);

  return { user, checked, refresh, setUser, signOut };
}

export function SiteHeader({
  siteName,
  user,
  onSignOut,
}: {
  siteName: string;
  user: SessionUserDTO | null;
  onSignOut?: () => void;
}) {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-20 border-b border-border bg-background/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <Link href="/" className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-md bg-foreground font-bold text-background">
            N
          </span>
          <span className="hidden sm:block">
            <span className="block text-sm font-semibold tracking-wide text-foreground">{siteName}</span>
            <span className="block text-[11px] uppercase tracking-widest text-muted-foreground">
              FRAZIYM TECH &amp; AI
            </span>
          </span>
        </Link>

        <nav className="flex items-center gap-1" aria-label="Site">
          {NAV.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={
                  'rounded-md px-2.5 py-1.5 text-xs transition-colors sm:text-sm ' +
                  (active
                    ? 'bg-muted font-medium text-foreground'
                    : 'text-muted-foreground hover:text-foreground')
                }
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="flex min-w-0 items-center gap-2">
          {user && (
            <span className="hidden max-w-[180px] truncate text-xs text-muted-foreground md:block">
              {user.email}
            </span>
          )}
          {user && onSignOut && (
            <Button variant="outline" size="sm" onClick={onSignOut}>
              Sign out
            </Button>
          )}
        </div>
      </div>
    </header>
  );
}

export function SiteFooter({ siteName }: { siteName: string }) {
  return (
    <footer className="mt-auto border-t border-border bg-background">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-4 text-xs text-muted-foreground sm:px-6">
        <span>
          {siteName} <span className="font-mono">{NURAE_VERSION}</span> — Autonomous Digital Operations System
        </span>
        <span className="flex items-center gap-3">
          <Link href="/help" className="hover:text-foreground">Help</Link>
          <Link href="/about" className="hover:text-foreground">About</Link>
          <span>FRAZIYM TECH &amp; AI</span>
        </span>
      </div>
    </footer>
  );
}

export function SiteSplash() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="text-sm text-muted-foreground">Loading {''}NURAE…</div>
    </div>
  );
}
