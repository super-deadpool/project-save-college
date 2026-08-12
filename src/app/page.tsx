import { redirect } from 'next/navigation';
import { getSession, homeFor } from '@/lib/auth/session';

export default async function Home() {
  const session = await getSession();
  redirect(session ? homeFor(session.role) : '/login');
}
