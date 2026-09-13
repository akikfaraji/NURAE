import { Suspense } from 'react';
import { SiteHome } from '@/components/nurae/site';

/**
 * NURAE public site — HOME. Landing page + customer sign-up/sign-in
 * (Gmail verification + Google). Signed-in customers are routed to /chat.
 * Other user pages: /chat, /help, /about. The admin console lives at /admin
 * (no public link — the operator reaches it by URL).
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
      <SiteHome />
    </Suspense>
  );
}
