'use client';

/**
 * NURAE dashboard — shared presentational bits.
 * Visual language: zinc neutrals + emerald accent, clean ops-console look.
 */

import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

const STATUS_STYLES: Record<string, { label: string; className: string }> = {
  running: { label: 'Running', className: 'bg-emerald-100 text-emerald-800 border-emerald-300' },
  starting: { label: 'Starting…', className: 'bg-amber-100 text-amber-800 border-amber-300' },
  stopping: { label: 'Stopping…', className: 'bg-amber-100 text-amber-800 border-amber-300' },
  stopped: { label: 'Stopped', className: 'bg-zinc-100 text-zinc-700 border-zinc-300' },
  error: { label: 'Error', className: 'bg-red-100 text-red-800 border-red-300' },
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const style = STATUS_STYLES[status] ?? { label: status, className: 'bg-zinc-100 text-zinc-700 border-zinc-300' };
  return (
    <Badge variant="outline" className={cn(style.className, className)} data-testid={`bot-status-${status}`}>
      <span
        className={cn(
          'mr-1.5 inline-block h-1.5 w-1.5 rounded-full',
          status === 'running' && 'animate-pulse bg-emerald-500',
          status === 'error' && 'bg-red-500',
          (status === 'starting' || status === 'stopping') && 'animate-pulse bg-amber-500',
          status === 'stopped' && 'bg-zinc-400',
        )}
      />
      {style.label}
    </Badge>
  );
}

export function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: number | string;
  accent?: 'emerald' | 'zinc' | 'red';
}) {
  return (
    <Card className="border-zinc-200 shadow-sm">
      <CardContent className="p-4 sm:p-6">
        <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</p>
        <p
          className={cn(
            'mt-1 text-2xl font-semibold tabular-nums sm:text-3xl',
            accent === 'emerald' && 'text-emerald-600',
            accent === 'red' && 'text-red-600',
            (!accent || accent === 'zinc') && 'text-zinc-900',
          )}
        >
          {value}
        </p>
      </CardContent>
    </Card>
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
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 px-6 py-12 text-center">
      <h3 className="text-sm font-semibold text-zinc-900">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-zinc-500">{description}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function BotMeta({ items }: { items: Array<{ label: string; value: React.ReactNode }> }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500">{item.label}</dt>
          <dd className="mt-0.5 truncate text-sm font-medium text-zinc-900">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function fieldErrorText(fields: Record<string, string> | undefined, key: string): string | undefined {
  return fields?.[key];
}
