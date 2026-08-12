import { requireRole } from '@/lib/auth/session';
import { CampusDashboard } from './campus';
import { DepartmentDashboard } from './department';

/**
 * One route, two dashboards (§31 and §32).
 *
 * An administrator's question is "what is happening across campus"; a
 * department's is "what needs attention right now". They are different screens
 * because they are different questions, and giving a staff member the campus view
 * would bury their own queue in numbers they cannot act on.
 */
export default async function DashboardPage() {
  const session = await requireRole('STAFF', 'DEPT_MANAGER', 'ADMIN');

  if (session.role === 'ADMIN') return <CampusDashboard />;

  if (!session.departmentId) {
    return (
      <div>
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <p className="mt-2 text-sm text-muted">
          This account is not attached to a department yet, so there is nothing to summarise.
        </p>
      </div>
    );
  }

  return <DepartmentDashboard departmentId={session.departmentId} />;
}
