'use client';

/**
 * NURAE dashboard — shared presentational bits.
 * Visual language: premium black monochrome (zero chroma except the
 * restrained error red), rounded-md controls, clean ops-console look.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { motion, MotionConfig } from 'framer-motion';
import { cn } from '@/lib/utils';

const STATUS_STYLES: Record<string, { label: string; className: string }> = {
  running: { label: 'Running', className: 'bg-foreground text-background border-transparent' },
  starting: { label: 'Starting…', className: 'bg-muted text-foreground border-border' },
  stopping: { label: 'Stopping…', className: 'bg-muted text-foreground border-border' },
  stopped: { label: 'Stopped', className: 'bg-muted text-foreground border-border' },
  error: { label: 'Error', className: 'border-destructive/40 bg-destructive/10 text-destructive' },
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const style = STATUS_STYLES[status] ?? { label: status, className: 'bg-muted text-foreground border-border' };
  return (
    <Badge variant="outline" className={cn(style.className, className)} data-testid={`bot-status-${status}`}>
      <span
        className={cn(
          'mr-1.5 inline-block h-1.5 w-1.5 rounded-full',
          status === 'running' && 'animate-pulse bg-foreground',
          status === 'error' && 'bg-destructive',
          (status === 'starting' || status === 'stopping') && 'animate-pulse bg-muted-foreground',
          status === 'stopped' && 'bg-muted-foreground/60',
        )}
      />
      {style.label}
    </Badge>
  );
}

/** Typographic stat line — real numbers, no boxes. The dashboard pattern:
 *  `label value · label value` reads in one glance and never pretends that
 *  an empty account has "cards" of content. */
export function StatLine({
  items,
  className,
}: {
  items: Array<{ label: string; value: React.ReactNode; alert?: boolean }>;
  className?: string;
}) {
  return (
    <p className={cn('flex flex-wrap items-baseline gap-x-5 gap-y-1 text-sm', className)}>
      {items.map((item) => (
        <span key={item.label} className="flex items-baseline gap-2">
          <span className="text-xs text-muted-foreground">{item.label}</span>
          <span
            className={cn(
              'text-sm font-medium tabular-nums',
              item.alert ? 'text-destructive' : 'text-foreground',
            )}
          >
            {item.value}
          </span>
        </span>
      ))}
    </p>
  );
}

/** Small all-caps label chip — one shared shape for official/category/
 *  transport/verified markers (was hand-rolled at three sizes). */
export function Pill({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        'rounded-full border-border px-2 py-0.5 text-[10px] font-medium uppercase tracking-widest text-muted-foreground',
        className,
      )}
    >
      {children}
    </Badge>
  );
}

/** Inline loading row — replaces bare “Loading…” paragraphs. */
export function LoadingRow({ label = 'Loading…' }: { label?: string }) {
  return (
    <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
      <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground" aria-hidden />
      {label}
    </p>
  );
}

/** Quiet failure panel — one honest idiom for "the data did not arrive",
 *  visually distinct from the dashed EmptyState so a broken load can never
 *  masquerade as "nothing here yet". */
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
      className={cn(
        'flex flex-col items-center justify-center rounded-lg border border-border px-6 py-10 text-center',
        className,
      )}
    >
      <p className="max-w-sm text-sm leading-relaxed text-foreground">{message}</p>
      {onRetry && (
        <Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

/** One primitive for the three data states — loading, failed, empty, then the
 *  real content. Stops every view from inventing its own loading/error idiom. */
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
      <div className={cn('px-4 py-10 text-center sm:px-6', className)}>
        <LoadingRow label={loadingLabel ?? 'Loading…'} />
      </div>
    );
  }
  if (error) {
    return (
      <div className={cn('px-4 py-6 sm:px-6', className)}>
        <ErrorPanel message={error} onRetry={onRetry} />
      </div>
    );
  }
  if (isEmpty) {
    return <div className={className}>{empty}</div>;
  }
  return <div className={className}>{children}</div>;
}

/** Route-level fade — restrained by design: 6px rise, 240ms, out like a
 *  breath. Respects prefers-reduced-motion via MotionConfig. */
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
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border px-6 py-12 text-center">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function BotMeta({ items }: { items: Array<{ label: string; value: React.ReactNode }> }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{item.label}</dt>
          <dd className="mt-0.5 truncate text-sm font-medium text-foreground">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function fieldErrorText(fields: Record<string, string> | undefined, key: string): string | undefined {
  return fields?.[key];
}
