import { NuraeConsole } from '@/components/nurae/console';

/** NURAE admin — /admin/agent (real route for the agent section). */
export default function Page() {
  return <NuraeConsole initialSection="agent" />;
}
