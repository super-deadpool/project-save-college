import { NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/api';
import { campusOverview, departmentDashboard } from '@/lib/analytics/service';

/**
 * §31 and §32 as JSON — the same service the dashboard pages render, so a figure
 * on screen can be checked against this endpoint and against the SQL underneath
 * it. That is what the Layer 10 gate does.
 *
 * Role decides the scope, not a query parameter: an administrator gets the campus,
 * a department gets itself. A staff member cannot ask for another department's
 * numbers by editing a URL.
 */
export async function GET(request: Request) {
  const session = await requireApiRole('STAFF', 'DEPT_MANAGER', 'ADMIN');
  if (session instanceof NextResponse) return session;

  const months = Number(new URL(request.url).searchParams.get('months') ?? '6');
  const window = Number.isFinite(months) && months >= 1 && months <= 24 ? Math.trunc(months) : 6;

  if (session.role === 'ADMIN') {
    const overview = await campusOverview(window);
    return NextResponse.json({
      scope: 'CAMPUS',
      window: overview.window,
      totals: overview.totals,
      satisfaction: overview.satisfaction,
      health: overview.health,
      categoryHealth: overview.categoryHealth,
      categories: overview.categories,
      departments: overview.departments,
      heat: overview.heat,
      heatHeadline: overview.heatHeadline,
      recurring: overview.recurring,
      trend: overview.trend,
      incidents: overview.incidents,
      reopened: overview.reopened,
    });
  }

  if (!session.departmentId) {
    return NextResponse.json({ error: 'This account has no department' }, { status: 409 });
  }

  const view = await departmentDashboard(session.departmentId, window);
  if (!view) return NextResponse.json({ error: 'Department not found' }, { status: 404 });

  return NextResponse.json({ scope: 'DEPARTMENT', ...view });
}
