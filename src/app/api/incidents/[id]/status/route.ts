import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireApiRole } from '@/lib/auth/api';
import { applyIncidentStatus } from '@/lib/incidents/actions';
import { loadIncident } from '@/lib/incidents/view';
import { ComplaintStatus } from '@/generated/prisma/enums';

const IncidentStatusBody = z.object({
  status: z.enum(ComplaintStatus),
  note: z.string().trim().max(2000).optional(),
});

/**
 * §17's whole point: one action on the incident, every member complaint moved.
 * The status in the body is a *complaint* status — the incident's own status is
 * never written directly, it is recomputed from the members afterwards.
 */
export async function POST(request: Request, { params }: RouteContext<'/api/incidents/[id]/status'>) {
  const session = await requireApiRole('STAFF', 'DEPT_MANAGER', 'ADMIN');
  if (session instanceof NextResponse) return session;

  const parsed = IncidentStatusBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'A valid status is required' }, { status: 400 });
  }

  const { id } = await params;
  const before = await loadIncident(id);
  if (!before) return NextResponse.json({ error: 'Incident not found' }, { status: 404 });

  // Same rule as the merge route: staff act inside their own department.
  if (session.role !== 'ADMIN') {
    const mine = before.incident.complaints.some((c) => c.departmentId === session.departmentId);
    if (!mine) return NextResponse.json({ error: 'Not your department' }, { status: 403 });
  }

  const result = await applyIncidentStatus({
    incidentId: id,
    to: parsed.data.status,
    actor: { id: session.sub, role: session.role },
    note: parsed.data.note ?? null,
    scopeDepartmentId: session.role === 'ADMIN' ? null : session.departmentId,
  });
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: 404 });

  // Nothing moved at all: the caller asked for something none of the members
  // could do, which is a conflict rather than a success with an empty list.
  if (result.applied.length === 0) {
    return NextResponse.json(
      { error: 'No complaint in this incident could make that move', skipped: result.skipped },
      { status: 409 },
    );
  }

  const after = await loadIncident(id);
  return NextResponse.json({
    incident: {
      id,
      code: after?.incident.code,
      status: after?.incident.status,
      affectedCount: after?.incident.affectedCount,
    },
    applied: result.applied,
    skipped: result.skipped,
  });
}
