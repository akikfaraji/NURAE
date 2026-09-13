import { Suspense } from 'react';
import { AgentsView } from '@/components/nurae/agents-view';

/** NURAE — /chats/agents: agent workspaces (Bot Builder first). */
export default function Page() {
  return (
    <Suspense
      fallback={
        <div className="flex h-dvh items-center justify-center bg-background">
          <div className="text-xs text-muted-foreground">Loading…</div>
        </div>
      }
    >
      <AgentsView />
    </Suspense>
  );
}
