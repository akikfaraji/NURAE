import { redirect } from 'next/navigation';

/** /admin redirects to the dashboard section — real routes live at /admin/<section>. */
export default function Page() {
  redirect('/admin/dashboard');
}
