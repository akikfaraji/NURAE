'use client';

/**
 * NURAE — shared presentational bits.
 *
 * These render on every page (status badges in every bot row, pills in three
 * shells, LoadState in every data view), so they are the second lever after
 * the design tokens: restyle here and the whole product moves at once.
 *
 * The visual contract is the depth system (see globals.css): 10px mono labels,
 * 30px controls, hairline dividers, no decorative colour. Colour is reserved
 * for state that is genuinely bad (error) or genuinely good (running), and
 * even then it is one dot plus a word, not a glowing badge.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { motion, MotionConfig } from 'framer-motion';
import { cn } from '@/lib/utils';
import { SkeletonRows } from '@/components/nurae/depth';

const STATUS_STYLES: Record<string, { label: string; className: string; dot: string }> = {
  running: {
    label: 'Running',
    className: 'border-transparent bg-foreground text-background',
    dot: 'bg-background',
  },
  starting: { label: 'Starting', className: 'border-[color:var(--depth-line)] bg-white/5 text-foreground', dot: 'bg-muted-foreground animate-pulse' },
  stopping: { label: 'Stopping', className: 'border-[color:var(--depth-line)] bg-white/5 text-foreground', dot: 'bg-muted-foreground animate-pulse' },
  stopped: { label: 'Stopped', className: 'border-[color:var(--depth-line)] bg-transparent text-muted-foreground', dot: 'bg-muted-foreground/60' },
  error: { label: 'Error', className: 'border-destructive/40 bg-destructive/10 text-destructive', dot: 'bg-destructive' },
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const style = STATUS_STYLES[status] ?? {
    label: status,
    className: 'border-[color:var(--depth-line)] bg-transparent text-muted-foreground',
    dot: 'bg-muted-foreground/60',
  };
  return (
    <Badge
      variant="outline"
      className={cn(
        'h-[20px] gap-1.5 rounded-full px-2 py-0 font-mono text-[10px] font-medium uppercase tracking-[0.06em]',
        style.className,
        className,
      )}
      data-testid={`bot-status-${status}`}
    >
      <span className={cn('inline-block h-1.5 w-1.5 rounded-full', style.dot)} aria-hidden="true" />
      {style.label}
    </Badge>
  );
}

/**
 * Typographic stat line. Kept because the dashboard pattern is still right:
 * `label value` reads in one glance and never pretends an empty account has
 * "cards" of content.
 */
export function StatLine({
  items,
  className,
}: {
  items: Array<{ label: string; value: React.ReactNode; alert?: boolean }>;
  className?: string;
}) {
  return (
    <dl className={cn('flex flex-wrap items-baseline gap-x-6 gap-y-1', className)}>
      {items.map((item) => (
        <div key={item.label} className="flex items-baseline gap-2">
          <dt className="n-kicker">{item.label}</dt>
          <dd
            className={cn(
              'n-num m-0 text-[13px] font-medium',
              item.alert ? 'text-destructive' : 'text-foreground',
            )}
          >
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** One shared all-caps marker for official / category / transport labels. */
export function Pill({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-[20px] items-center rounded-full border border-[color:var(--depth-line)] px-2',
        'font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground',
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Inline loading row for surfaces that do not know their final shape. */
export function LoadingRow({ label = 'Loading…' }: { label?: string }) {
  return (
    <p className="flex items-center gap-2 text-[12px] text-muted-foreground" role="status">
      <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground" aria-hidden />
      {label}
    </p>
  );
}

/**
 * Quiet failure panel. Visually distinct from the dashed EmptyState so a
 * broken load can never masquerade as "nothing here yet".
 */
export function ErrorPanel({
  message,
  onRetry,
  className,
}: {
  message: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn('n-glass flex flex-col items-start gap-3 px-4 py-4', className)}
    >
      <p className="m-0 max-w-prose text-[12.5px] leading-relaxed text-foreground">{message}</p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

/**
 * One primitive for the three data states. Loading now renders rows shaped
 * like the data instead of a centred sentence, so the layout does not jump
 * when the response lands.
 */
export function LoadState({
  loading,
  error,
  onRetry,
  isEmpty,
  empty,
  loadingLabel,
  children,
  className,
}: {
  loading: boolean;
  error: string | null;
  onRetry?: () => void;
  isEmpty: boolean;
  empty?: React.ReactNode;
  loadingLabel?: string;
  children: React.ReactNode;
  className?: string;
}) {
  if (loading) {
    return (
      <div className={cn('py-3', className)} role="status" aria-label={loadingLabel ?? 'Loading'}>
        <SkeletonRows rows={4} />
      </div>
    );
  }
  if (error) {
    return (
      <div className={cn('py-2', className)}>
        <ErrorPanel message={error} onRetry={onRetry} />
      </div>
    );
  }
  if (isEmpty) {
    return <div className={className}>{empty}</div>;
  }
  return <div className={className}>{children}</div>;
}

/** Route-level fade: 6px rise, 240ms, opacity only, reduced-motion aware. */
export function PageFade({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <MotionConfig reducedMotion="user">
      <motion.div
        className={className}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.24, ease: 'easeOut' }}
      >
        {children}
      </motion.div>
    </MotionConfig>
  );
}

/** Empty state: a hairline surface with one action, not a dashed poster. */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="n-glass flex flex-col items-start gap-2 px-4 py-5">
      <h3 className="m-0 text-[13px] font-medium text-foreground">{title}</h3>
      <p className="m-0 max-w-prose text-[12.5px] leading-relaxed text-muted-foreground">{description}</p>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

/** Definition grid used by bot configuration surfaces. */
export function BotMeta({ items }: { items: Array<{ label: string; value: React.ReactNode }> }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="n-kicker">{item.label}</dt>
          <dd className="m-0 mt-1 truncate text-[13px] text-foreground">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function fieldErrorText(fields: Record<string, string> | undefined, key: string): string | undefined {
  return fields?.[key];
}
