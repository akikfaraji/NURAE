'use client';

/**
 * NURAE — application chrome.
 *
 * One small, unobtrusive header for the whole product:
 *   left    compact navigation (text, no pills, no cards)
 *   right   account (menu — sign out lives HERE, not as a giant button)
 *           and the small N mark at the very top-right corner.
 *
 * The chrome is 48px tall, hairline-bordered, nearly invisible. On mobile
 * the navigation collapses into a sheet behind a quiet menu button.
 * Public pages and the authenticated app share this identity but NOT the
 * layout: app pages (chats/bots/agents) run full-height with no footer;
 * public pages keep the slim footer.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { toast } from 'sonner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { SessionUserDTO, nuraeApi } from '@/lib/nurae-client/api';
import { NURAE_VERSION } from '@/lib/nurae/version';

const NAV = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/chats', label: 'Chats' },
  { href: '/chats/agents', label: 'Agents' },
  { href: '/bots', label: 'Bots' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/billing', label: 'Billing' },
] as const;

const PUBLIC_NAV = [
  { href: '/', label: 'Home' },
  { href: '/featured', label: 'Featured' },
  { href: '/pricing', label: 'Pricing' },
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
    (async () => {
      await refresh();
    })();
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

// ---------------------------------------------------------------------------
// N mark — small, top-right, quiet
// ---------------------------------------------------------------------------

export function NMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={
        'flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border text-[11px] font-semibold leading-none text-foreground ' +
        (className ?? '')
      }
    >
      N
    </span>
  );
}

function NavLink({ href, label, active, onClick }: { href: string; label: string; active: boolean; onClick?: () => void }) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
      className={
        'text-xs transition-colors sm:text-[13px] ' +
        (active
          ? 'font-medium text-foreground'
          : 'text-muted-foreground hover:text-foreground')
      }
    >
      {label}
    </Link>
  );
}

/** Active-area rule: EXACT match first, then the LONGEST href prefix — so
 *  `/` never swallows every route and `/chats/agents` highlights Agents
 *  without also lighting up Chats. */
function activeHref(pathname: string, items: ReadonlyArray<{ href: string; label: string }>): string | null {
  const exact = items.find((i) => i.href === pathname);
  if (exact) return exact.href;
  const prefixed = items
    .filter((i) => i.href !== '/' && pathname.startsWith(i.href + '/'))
    .sort((a, b) => b.href.length - a.href.length);
  return prefixed[0]?.href ?? null;
}

// ---------------------------------------------------------------------------
// Account menu — the intentional interaction behind sign out
// ---------------------------------------------------------------------------

function AccountMenu({ user, onSignOut }: { user: SessionUserDTO; onSignOut?: () => void }) {
  const [inviteOpen, setInviteOpen] = useState(false);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Account menu"
        className="flex h-7 max-w-[160px] items-center gap-2 rounded-sm px-1.5 text-xs text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:text-foreground"
      >
        <span className="truncate">{user.name || user.email}</span>
        <svg viewBox="0 0 8 8" className="h-2 w-2 shrink-0 opacity-60" aria-hidden>
          <path d="M0 2l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1" />
        </svg>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="truncate font-normal text-xs text-muted-foreground">
          {user.email}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => setInviteOpen(true)} className="text-xs">
          Invite a friend
          <span className="ml-auto text-[10px] text-muted-foreground">2 days premium</span>
        </DropdownMenuItem>
        <DropdownMenuItem asChild className="text-xs">
          <Link href="/help">Help</Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {onSignOut && (
          <DropdownMenuItem onClick={onSignOut} className="text-xs text-muted-foreground focus:text-foreground">
            Sign out
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
      <InviteDialog open={inviteOpen} onClose={() => setInviteOpen(false)} />
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------------------
// Invite — the lightweight referral surface (no dashboard page)
// ---------------------------------------------------------------------------

export function InviteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [data, setData] = useState<{ code: string; invited: number; qualified: number; rewardDaysTotal: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    (async () => {
      setError(null);
      setCopied(false);
      try {
        const r = await nuraeApi.referral();
        setData(r.referral);
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, [open]);

  const link = data ? `${typeof window !== 'undefined' ? window.location.origin : ''}/?ref=${data.code}` : '';

  /** Copy that tells the truth: Clipboard API first, hidden-textarea
   *  fallback second, and an honest error (with the code visible for manual
   *  copy) when the browser refuses both. */
  const copyLink = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(link);
        setCopied(true);
        return;
      }
      throw new Error('clipboard unavailable');
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = link;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (!ok) throw new Error('copy rejected');
        setCopied(true);
      } catch {
        setCopied(false);
        toast.error('Could not copy automatically — select the link below and copy it manually.');
      }
    }
  };

  return (
    <Sheet open={open} onOpenChange={(v) => (!v ? onClose() : undefined)}>
      <SheetContent side="bottom" className="mx-auto max-w-md rounded-t-lg border-border bg-background p-6 sm:p-6">
        <SheetTitle className="text-sm font-medium text-foreground">Invite a friend</SheetTitle>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          Share your link. When someone signs up through it and verifies their email,
          you get <span className="text-foreground">2 days of premium features</span>. Quietly tracked,
          no dashboard to manage.
        </p>
        {error && <p className="mt-3 text-xs text-destructive">{error}</p>}
        {data && (
          <>
            {/* The link itself stays selectable — manual copy is always possible. */}
            <button
              type="button"
              onClick={() => void copyLink()}
              className="mt-4 w-full truncate rounded-md border border-border px-3 py-2 text-left font-mono text-xs text-foreground transition-colors hover:bg-muted/50"
            >
              {copied ? 'Copied to clipboard' : link}
            </button>
            <p className="mt-3 text-[11px] text-muted-foreground">
              {data.qualified > 0
                ? `${data.qualified} friend${data.qualified === 1 ? '' : 's'} joined — ${data.rewardDaysTotal} premium day(s) earned so far.`
                : 'No invites joined yet.'}
            </p>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// The header
// ---------------------------------------------------------------------------

export function SiteHeader({
  user,
  onSignOut,
  variant = 'app',
  hideMobileMenu = false,
}: {
  user: SessionUserDTO | null;
  onSignOut?: () => void;
  /** "app" shows the product nav; "public" shows Home/Help/About. */
  variant?: 'app' | 'public';
  /** Chat surfaces render their own single session-drawer trigger — the
   * header hamburger would stack a SECOND menu button on the same screen. */
  hideMobileMenu?: boolean;
}) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const nav = variant === 'public' ? PUBLIC_NAV : NAV;
  const extraNav = variant === 'public' ? [] : ([{ href: '/help', label: 'Help' }] as const);

  // PUBLIC_NAV already carries Home and About — blanket-appending them again
  // produced duplicate hrefs and duplicate React keys. Dedupe, keeping the
  // first occurrence's label.
  const mobileNavItems = (() => {
    const merged = [...nav, ...extraNav, { href: '/', label: 'Home' as const }, { href: '/about', label: 'About' as const }];
    const seen = new Set<string>();
    return merged.filter((item) => {
      if (seen.has(item.href)) return false;
      seen.add(item.href);
      return true;
    });
  })();

  const currentHref = activeHref(pathname, [...nav, ...extraNav]);

  return (
    <header className="sticky top-0 z-30 shrink-0 border-b border-border/60 bg-background/85 backdrop-blur">
      <div className="mx-auto flex h-12 max-w-6xl items-center gap-4 px-4 sm:px-6">
        {/* Mobile menu */}
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          {!hideMobileMenu && (
            <SheetTrigger
              aria-label="Open menu"
              className="-ml-1 flex h-8 w-8 items-center justify-center text-muted-foreground hover:text-foreground sm:hidden"
            >
              <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden>
                <path d="M1 3.5h14M1 8h14M1 12.5h14" stroke="currentColor" strokeWidth="1.2" />
              </svg>
            </SheetTrigger>
          )}
          <SheetContent side="left" className="w-64 border-border bg-background p-5">
            <SheetTitle className="text-xs uppercase tracking-widest text-muted-foreground">NURAE</SheetTitle>
            <nav className="mt-4 flex flex-col gap-1" aria-label="Site">
              {mobileNavItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMobileOpen(false)}
                  className={
                    'rounded-sm px-2 py-1.5 text-sm ' +
                    (item.href === currentHref ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')
                  }
                >
                  {item.label}
                </Link>
              ))}
            </nav>
            <p className="mt-6 border-t border-border pt-4 font-mono text-[10px] text-muted-foreground">{NURAE_VERSION}</p>
          </SheetContent>
        </Sheet>

        {/* Desktop nav — the wordmark IS the nav's first item, kept small */}
        <nav className="hidden items-center gap-5 sm:flex" aria-label="Site">
          {user ? (
            nav.map((item) => <NavLink key={item.href} {...item} active={item.href === currentHref} />)
          ) : (
            PUBLIC_NAV.map((item) => <NavLink key={item.href} {...item} active={item.href === currentHref} />)
          )}
          {user && extraNav.map((item) => <NavLink key={item.href} {...item} active={item.href === currentHref} />)}
        </nav>

        {/* Mobile: current area label — exact match first, then longest prefix */}
        <span className={"truncate text-xs font-medium text-foreground sm:hidden " + (hideMobileMenu ? "pl-0" : "")}>
          {[...nav, ...extraNav].find((n) => n.href === currentHref)?.label ?? 'NURAE'}
        </span>

        <div className="ml-auto flex items-center gap-3">
          {user ? (
            <AccountMenu user={user} onSignOut={onSignOut} />
          ) : (
            <Link
              href="/"
              className="text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              Sign in
            </Link>
          )}
          <NMark />
        </div>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Footer (public pages only — app pages have none)
// ---------------------------------------------------------------------------

export function SiteFooter({ siteName }: { siteName: string }) {
  return (
    <footer className="mt-auto border-t border-border/60 bg-background">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-4 text-[11px] text-muted-foreground sm:px-6">
        <span>
          {siteName} <span className="font-mono">{NURAE_VERSION}</span>
        </span>
        <span className="flex items-center gap-4">
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
      <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground" aria-hidden />
        Loading…
      </div>
    </div>
  );
}
