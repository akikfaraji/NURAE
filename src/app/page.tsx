import { Suspense } from 'react';
import { NuraeSite } from '@/components/nurae/site';

/**
 * NURAE public site — the home for normal users: landing page, customer
 * sign-up/sign-in (Gmail verification + Google) and the official NURAE CS
 * bot web chat. The admin console lives at /admin.
 */
export default function Home() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-background">
          <div className="text-sm text-muted-foreground">Loading NURAE…</div>
        </div>
      }
    >
      <NuraeSite />
    </Suspense>
  );
}
