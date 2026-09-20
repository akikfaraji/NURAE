import Link from 'next/link';
import { NURAE_VERSION } from '@/lib/nurae/version';

/**
 * NURAE — 404. Same language as the rest of the site: a quiet hairline card,
 * no illustration, no blame. The version line marks the instrument.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm rounded-lg border border-border p-8 text-center">
        <p className="text-[11px] uppercase tracking-widest text-muted-foreground">404</p>
        <h1 className="mt-2 text-lg font-medium tracking-tight text-foreground">
          This page does not exist.
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          The address may be mistyped, or the page has moved.
        </p>
        <Link
          href="/"
          className="mt-6 inline-flex min-h-11 items-center justify-center rounded-md border border-border px-4 text-sm text-foreground transition-colors hover:bg-muted/60"
        >
          Back to NURAE
        </Link>
        <p className="mt-6 font-mono text-[10px] text-muted-foreground">{NURAE_VERSION}</p>
      </div>
    </main>
  );
}
