'use client';

/**
 * NURAE — route-level error boundary. App Router requires a client
 * component; it renders inside the root layout, so the site chrome around
 * it still works. Quiet hairline card, honest message, one action.
 */

import Link from 'next/link';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { NURAE_VERSION } from '@/lib/nurae/version';

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surfaced in the browser console / observability — never in the UI.
    console.error(error);
  }, [error]);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm rounded-lg border border-border p-8 text-center">
        <p className="text-[11px] uppercase tracking-widest text-muted-foreground">Something broke</p>
        <h1 className="mt-2 text-lg font-medium tracking-tight text-foreground">
          This view failed to render.
        </h1>
        <p className="mt-2 break-words text-sm leading-relaxed text-muted-foreground">
          {error.message || 'An unexpected error occurred.'}
          {error.digest ? <span className="mt-1 block font-mono text-[10px]">ref {error.digest}</span> : null}
        </p>
        <div className="mt-6 flex flex-col items-center gap-3">
          <Button size="sm" variant="outline" onClick={reset} className="min-h-11">
            Try again
          </Button>
          <Link href="/" className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
            Back to NURAE
          </Link>
        </div>
        <p className="mt-6 font-mono text-[10px] text-muted-foreground">{NURAE_VERSION}</p>
      </div>
    </main>
  );
}
