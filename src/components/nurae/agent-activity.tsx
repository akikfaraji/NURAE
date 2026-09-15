'use client';

/**
 * NURAE — shared agent activity feed (agents-view + operator-view).
 *
 * Every tool call renders as one quiet row: status dot, tool name, human
 * label. Rows with an inspectable output (dataPreview from the audit trail,
 * or the live result data) expand on click to show WHAT the tool returned —
 * the "understandable progress" surface, upgraded from labels-only to real
 * tool-call + output inspection.
 */

import { useState } from 'react';

export interface ActivityStep {
  seq: number;
  tool: string;
  label: string;
  status: 'ok' | 'error' | 'confirm';
  detail?: string;
  dataPreview?: string;
  data?: unknown;
}

function outputOf(step: ActivityStep): string | null {
  if (step.dataPreview) return step.dataPreview;
  if (step.data === undefined || step.data === null) return null;
  try {
    const raw = typeof step.data === 'string' ? step.data : JSON.stringify(step.data);
    return raw ? (raw.length > 1200 ? raw.slice(0, 1200) + '…' : raw) : null;
  } catch {
    return null;
  }
}

export function AgentActivity({ steps, live }: { steps: ActivityStep[]; live?: boolean }) {
  return (
    <ul className="space-y-1 border-l border-border/70 pl-3" aria-live={live ? 'polite' : undefined}>
      {steps.map((s) => (
        <ActivityRow key={s.seq} step={s} />
      ))}
    </ul>
  );
}

function ActivityRow({ step }: { step: ActivityStep }) {
  const [open, setOpen] = useState(false);
  const output = outputOf(step);
  const expandable = Boolean(output || step.detail);
  const hasOutput = Boolean(output);

  return (
    <li className="text-xs">
      {expandable ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex w-full items-baseline gap-2 rounded-sm text-left transition-colors hover:text-foreground"
          title={hasOutput ? 'Show the tool result' : undefined}
        >
          <StatusDot status={step.status} />
          <span className={'font-mono text-[11px] ' + (step.status === 'error' ? 'text-destructive' : 'text-foreground/70')}>
            {step.tool}
          </span>
          <span className={step.status === 'error' ? 'text-destructive' : 'text-muted-foreground'}>{step.label}</span>
          {hasOutput && (
            <span className="ml-auto shrink-0 rounded border border-border px-1 text-[10px] text-muted-foreground/80">
              {open ? 'hide output' : 'output'}
            </span>
          )}
        </button>
      ) : (
        <span className="flex items-baseline gap-2">
          <StatusDot status={step.status} />
          <span className={'font-mono text-[11px] ' + (step.status === 'error' ? 'text-destructive' : 'text-foreground/70')}>
            {step.tool}
          </span>
          <span className={step.status === 'error' ? 'text-destructive' : 'text-muted-foreground'}>{step.label}</span>
        </span>
      )}
      {open && (
        <div className="ml-5 mt-1 space-y-1">
          {step.detail && <p className="text-[11px] leading-relaxed text-muted-foreground">{step.detail}</p>}
          {output && (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/70 bg-muted/40 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-foreground/80">
              {output}
            </pre>
          )}
        </div>
      )}
    </li>
  );
}

function StatusDot({ status }: { status: ActivityStep['status'] }) {
  return (
    <span
      className={
        'inline-block h-2 w-2 shrink-0 rounded-full ' +
        (status === 'ok'
          ? 'bg-foreground'
          : status === 'confirm'
            ? 'animate-pulse bg-muted-foreground'
            : 'bg-destructive')
      }
      aria-hidden
    />
  );
}
