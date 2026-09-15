import { redirect } from 'next/navigation';

/** /chat → /dashboard — the console's front door is the user dashboard now. */
export default function Page() {
  redirect('/dashboard');
}
