import { requireSession } from '@/lib/auth/session';
import { AppNav } from '@/components/app-nav';

export default async function AppLayout({ children }: LayoutProps<'/'>) {
  const session = await requireSession();

  return (
    <div className="flex min-h-screen flex-col">
      <AppNav name={session.name} role={session.role} />
      <main className="mx-auto w-full max-w-5xl flex-1 p-6">{children}</main>
    </div>
  );
}
