import { redirect } from 'next/navigation';

/** /chat moved to /chats — old links keep working. */
export default function Page() {
  redirect('/chats');
}
