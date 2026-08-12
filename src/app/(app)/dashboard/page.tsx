import { requireRole } from '@/lib/auth/session';

export default async function DashboardPage() {
  await requireRole('DEPT_MANAGER', 'ADMIN');
  return <h1 className="text-xl font-semibold">Dashboard</h1>;
}
