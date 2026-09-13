import { NuraeConsole } from '@/components/nurae/console';

/**
 * NURAE admin console — everything administrative lives under /admin:
 * projects, bots, customers, site settings. Protected by the admin token
 * (NURAE_ADMIN_TOKEN). The public site stays at /.
 */
export default function AdminPage() {
  return <NuraeConsole />;
}
