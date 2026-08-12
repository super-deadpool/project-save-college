'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { Role } from '@/generated/prisma/enums';

const NAV: Record<Role, { href: string; label: string }[]> = {
  STUDENT: [
    { href: '/report', label: 'Report an issue' },
    { href: '/complaints', label: 'My complaints' },
  ],
  // §32's dashboard is for the department, so staff get it too — "what needs
  // attention right now" is their question before it is their manager's.
  STAFF: [
    { href: '/dashboard', label: 'Dashboard' },
    { href: '/queue', label: 'Queue' },
  ],
  DEPT_MANAGER: [
    { href: '/dashboard', label: 'Dashboard' },
    { href: '/queue', label: 'Queue' },
  ],
  ADMIN: [
    { href: '/dashboard', label: 'Dashboard' },
    { href: '/queue', label: 'All complaints' },
  ],
};

const ROLE_LABEL: Record<Role, string> = {
  STUDENT: 'Student',
  STAFF: 'Staff',
  DEPT_MANAGER: 'Dept. manager',
  ADMIN: 'Admin',
};

export function AppNav({ name, role }: { name: string; role: Role }) {
  const pathname = usePathname();
  const router = useRouter();

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.replace('/login');
    router.refresh();
  }

  return (
    <header className="border-b border-line bg-surface">
      <div className="mx-auto flex w-full max-w-5xl items-center gap-6 px-6 py-3">
        <span className="font-semibold">Campus Complaints</span>
        <nav className="flex flex-1 gap-4 text-sm">
          {NAV[role].map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={active ? 'font-medium text-accent' : 'text-muted hover:text-foreground'}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <span className="text-sm text-muted">
          {name} · {ROLE_LABEL[role]}
        </span>
        <button onClick={logout} className="text-sm text-muted underline hover:text-foreground">
          Sign out
        </button>
      </div>
    </header>
  );
}
