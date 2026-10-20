'use client';

/**
 * NURAE — the depth primitives.
 *
 * The visual system from the V4 direction, in the real product: a living
 * background under four declared levels, glass only where elevation is real,
 * mono numerals, and motion that answers a question ("where did this come
 * from", "did my click land") instead of decorating.
 *
 * Why a module instead of ad-hoc Tailwind classes: the app already has 12
 * distinct type sizes and 34 card usages. Every new surface that hand-rolls
 * its own panel makes the inconsistency worse. These are the only shapes a
 * data surface needs, and they all read from the same three tokens.
 *
 * Rules encoded here (see globals.css for the enforcement):
 *   - `Glass` is level 1: panels, tables, stat blocks.
 *   - `Sheet` is level 2: detached surfaces only (drawer, palette).
 *   - `Ring` interpolates its fill on mount, and does not animate at all
 *     under prefers-reduced-motion.
 *   - Nothing in this file fetches, stores or invents a number.
 */

import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Which atmosphere sits behind a page. Same field, different light. */
export type DepthVariant = 'dashboard' | 'studio' | 'marketing';

/** Level 0: the living background. Fixed, inert, and behind every child. */
export function DepthBackground({ variant = 'dashboard' }: { variant?: DepthVariant }) {
  return <div className={cn('n-aurora', variant !== 'dashboard' && `n-aurora--${variant}`)} aria-hidden="true" />;
}

/**
 * Level 1 panel. `bleed` removes internal padding for tables that need their
 * rows to reach the panel edge.
 */
export function Glass({
  children,
  className,
  bleed = false,
  as: Tag = 'div',
}: {
  children: ReactNode;
  className?: string;
  bleed?: boolean;
  as?: 'div' | 'section' | 'aside';
}) {
  return <Tag className={cn('n-glass', bleed ? 'p-0' : 'p-4', className)}>{children}</Tag>;
}

/** Level 2 detached surface. Used for the command palette and drawers. */
export function Sheet({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('n-sheet', 'p-4', className)}>{children}</div>;
}

/** The one label style: 10px mono, wide tracking, muted. Never a heading. */
export function Kicker({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('n-kicker m-0 mb-2.5', className)}>{children}</p>;
}

/** A number with a name. No box unless the caller wraps it in Glass. */
export function Metric({
  label,
  value,
  sub,
  alert = false,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  alert?: boolean;
}) {
  return (
    <div className="min-w-0">
      <Kicker className="mb-1.5">{label}</Kicker>
      <div className={cn('n-num text-lg leading-none', alert ? 'text-destructive' : 'text-foreground')}>
        {value}
      </div>
      {sub ? <p className="mt-1 truncate text-[11px] text-muted-foreground">{sub}</p> : null}
    </div>
  );
}

/**
 * One event in the return loop. `when` is a real timestamp or a real state
 * description, never a fabricated "2 hours ago" for something that did not
 * happen.
 */
export function EventRow({
  mark,
  when,
  children,
}: {
  mark: ReactNode;
  when?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-2.5 border-b border-[color:var(--depth-line-soft)] py-2.5 last:border-b-0">
      <span
        className="mt-0.5 flex h-[18px] w-[18px] flex-none items-center justify-center rounded-full border border-[color:var(--depth-line)] font-mono text-[10px] text-muted-foreground"
        aria-hidden="true"
      >
        {mark}
      </span>
      <span className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-muted-foreground">{children}</span>
      {when ? <span className="n-num flex-none text-[10.5px] text-muted-foreground/70">{when}</span> : null}
    </div>
  );
}

/**
 * Allowance / countdown ring. `pct` is caller-supplied and must be derived
 * from a real value; the fill animates once on mount and is static when the
 * user prefers reduced motion.
 */
export function Ring({
  pct,
  center,
  label,
  sub,
}: {
  pct: number;
  center: ReactNode;
  label: string;
  sub?: ReactNode;
}) {
  const [fill, setFill] = useState(0);
  const target = Math.max(0, Math.min(100, Math.round(pct)));

  useEffect(() => {
    // One frame of 0%, then the real value, so the transition has a start.
    const raf = requestAnimationFrame(() => setFill(target));
    return () => cancelAnimationFrame(raf);
  }, [target]);

  return (
    <div className="flex items-center gap-4">
      <div
        className="n-ring"
        style={{ ['--n-fill' as string]: `${fill}%` }}
        role="img"
        aria-label={`${label}: ${target} percent`}
      >
        <span>{center}</span>
      </div>
      <div className="min-w-0">
        <Kicker className="mb-1">{label}</Kicker>
        {sub ? <p className="m-0 text-[12px] leading-relaxed text-muted-foreground">{sub}</p> : null}
      </div>
    </div>
  );
}

/** Resume-where-you-left-off strip: one line, a real progress value. */
export function ResumeStrip({
  title,
  step,
  total,
  href,
  cta,
}: {
  title: string;
  step: number;
  total: number;
  href: string;
  cta: string;
}) {
  const pct = total > 0 ? Math.round((step / total) * 100) : 0;
  return (
    <Glass className="flex flex-wrap items-center gap-3 py-3">
      <Kicker className="mb-0 flex-none">Continue</Kicker>
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground">{title}</span>
      <span
        className="hidden h-1 min-w-[120px] flex-1 overflow-hidden rounded-full bg-white/10 sm:block"
        aria-hidden="true"
      >
        <span className="block h-full bg-foreground" style={{ width: `${pct}%` }} />
      </span>
      <span className="n-num flex-none text-[10.5px] text-muted-foreground">
        step {step} of {total}
      </span>
      <Link href={href} className="n-press flex-none rounded-lg border border-[color:var(--depth-line)] px-2.5 py-1 text-[12px] text-foreground hover:bg-white/5">
        {cta}
      </Link>
    </Glass>
  );
}

/** Loading rows shaped like the table they replace. */
export function SkeletonRows({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2.5 py-1" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <span className="n-skel" style={{ width: '42%' }} />
          <span className="n-skel" style={{ width: '18%' }} />
          <span className="n-skel ml-auto" style={{ width: '12%' }} />
        </div>
      ))}
    </div>
  );
}

/**
 * Horizontal status bar. The raw "PROJECTS 2 ACTIVE BOTS 0 …" string was the
 * most-read line on the dashboard and the least designed. This is the same
 * data as a component: even spacing, a status dot per item, mono values, and
 * a hairline panel so it belongs to the container.
 *
 * Tone is semantic only (fail / attention / neutral) and stays inside the
 * monochrome palette; red appears only for an actual failure.
 */
export function StatusBar({
  items,
}: {
  items: Array<{ label: string; value: React.ReactNode; tone?: 'neutral' | 'ok' | 'warn' | 'bad' }>;
}) {
  const dot = (tone?: string) =>
    tone === 'bad'
      ? 'bg-destructive'
      : tone === 'warn'
        ? 'bg-foreground/50'
        : tone === 'ok'
          ? 'bg-foreground'
          : 'bg-foreground/20';
  return (
    <div className="flex flex-wrap items-center gap-x-7 gap-y-2 rounded-xl border border-[color:var(--depth-line)] bg-[#121318] px-4 py-2.5">
      {items.map((item) => (
        <div key={item.label} className="flex items-baseline gap-2">
          <span className={cn('inline-block h-1.5 w-1.5 rounded-full', dot(item.tone))} aria-hidden="true" />
          <span className="n-kicker">{item.label}</span>
          <span className="n-num text-[12.5px] text-foreground">{item.value}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * The one page scaffold. Every view that was hand-rolling
 * `relative flex min-h-screen flex-col` + `DepthBackground` + a `main` with
 * its own gutters + a title/actions row now renders through this, which is
 * how the fifth page stops drifting from the first four.
 *
 * What it owns:
 *   - the page shell (background variant + full-height column),
 *   - the standard header block: optional kicker above the h1, optional
 *     description, actions aligned to the baseline on the right,
 *   - the `n-stagger` entrance, so every page lands the same way.
 *
 * What it does NOT own: `SiteHeader`/`SiteFooter` (pages gate on auth before
 * they render those), horizontal gutters (globals.css already gives `main`
 * fluid `clamp()` gutters), and any data.
 */
export function PageContainer({
  variant = 'dashboard',
  kicker,
  title,
  description,
  actions,
  children,
  className,
  mainClassName,
}: {
  variant?: DepthVariant;
  kicker?: ReactNode;
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  /** Extra classes on the outer page column. */
  className?: string;
  /** Extra classes on the `main` (width measure, extra padding) when a page
   *  needs a measure beyond the fluid default. */
  mainClassName?: string;
}) {
  return (
    <div className={cn('relative flex min-h-screen flex-col', className)}>
      <DepthBackground variant={variant} />
      <main className={cn('relative z-10 w-full flex-1 py-6 sm:py-8', mainClassName)}>
        <div className="n-stagger">
          {(kicker || title || description || actions) && (
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div className="min-w-0">
                {kicker ? <Kicker className="mb-1.5">{kicker}</Kicker> : null}
                {title ? <h1>{title}</h1> : null}
                {description ? (
                  <p className="mt-1 max-w-[76ch] text-[12.5px] leading-relaxed text-muted-foreground">{description}</p>
                ) : null}
              </div>
              {actions ? <div className="flex flex-none flex-wrap items-center gap-2">{actions}</div> : null}
            </div>
          )}
          {children}
        </div>
      </main>
    </div>
  );
}
