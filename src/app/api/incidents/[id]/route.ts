import { NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/api';
import { canViewIncident, loadIncident, reporterLabel } from '@/lib/incidents/view';

export async function GET(_request: Request, { params }: RouteContext<'/api/incidents/[id]'>) {
  const session = await requireApiRole();
  if (session instanceof NextResponse) return session;

  const { id } = await params;
  const view = await loadIncident(id);
  if (!view) return NextResponse.json({ error: 'Incident not found' }, { status: 404 });
  // 404, not 403: an incident a student is not part of should not be confirmed
  // to exist by the error code alone.
  if (!canViewIncident(view, session)) {
    return NextResponse.json({ error: 'Incident not found' }, { status: 404 });
  }

  const isStudent = session.role === 'STUDENT';

  return NextResponse.json({
    incident: {
      id: view.incident.id,
      code: view.incident.code,
      title: view.incident.title,
      categoryKey: view.incident.categoryKey,
      status: view.incident.status,
      priority: view.incident.priority,
      affectedCount: view.incident.affectedCount,
      location: view.incident.location?.name ?? null,
      department: view.departmentName,
      createdAt: view.incident.createdAt,
      // §18's count is the whole point of the incident view; the rollup reason
      // explains why the incident may outrank every complaint inside it.
      priorityReason: view.rollup.reason,
      ...(isStudent ? {} : { signature: view.incident.signature }),
    },
    message: view.isShared ? view.message : null,
    // A student sees the scale of the incident, not a roster of their peers.
    complaints: view.incident.complaints
      .filter((c) => !isStudent || c.reporterId === session.sub)
      .map((c) => ({
        id: c.id,
        code: c.code,
        title: c.title,
        status: c.status,
        priority: c.priority,
        locationId: c.locationId,
        createdAt: c.createdAt,
        isMine: c.reporterId === session.sub,
        ...(isStudent
          ? {}
          : {
              reporter: reporterLabel(c, session.role),
              dedupVerdict: c.dedupVerdict,
              dedupScore: c.dedupScore,
            }),
      })),
  });
}
