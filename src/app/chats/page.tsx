import { Suspense } from 'react';
import { ChatsView } from '@/components/nurae/chats-view';

/** NURAE — /chats: the full-page conversation environment (signed-in customers). */
export default function Page() {
  return (
    <Suspense
      fallback={
        <div className="flex h-dvh items-center justify-center bg-background">
          <div className="text-xs text-muted-foreground">Loading…</div>
        </div>
      }
    >
      <ChatsView />
    </Suspense>
  );
}
