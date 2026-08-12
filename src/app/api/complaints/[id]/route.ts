import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireApiRole } from '@/lib/auth/api';
import { nextStatuses } from '@/lib/lifecycle/machine';
import { stepperFor } from '@/lib/lifecycle/stepper';
import { statusStamps, timelineEntry, visibleTo } from '@/lib/lifecycle/timeline';

/**
 * One complaint, as §20 describes it: where it has got to, and what happened
 * along the way. The same two pure functions the tracking page renders, so the
 * API and the page can never tell different stories.
 */
export async function GET(_request: Request, { params }: RouteContext<'/api/complaints/[id]'>) {
  const session = await requireApiRole();
  if (session instanceof NextResponse) return session;

  const { id } = await params;
  const complaint = await prisma.complaint.findUnique({
    where: { id },
    include: {
      department: true,
      location: true,
      assignee: true,
      incident: true,
      // cuid v1 sorts by creation time, which keeps two events written in the
      // same millisecond — submission writes three — in the order they happened.
      events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], include: { actor: true } },
    },
  });
  if (!complaint) return NextResponse.json({ error: 'Complaint not found' }, { status: 404 });

  const mayView =
    session.role === 'ADMIN' ||
    complaint.reporterId === session.sub ||
    (session.departmentId != null && complaint.departmentId === session.departmentId);
  if (!mayView) return NextResponse.json({ error: 'Complaint not found' }, { status: 404 });

  const isStudent = session.role === 'STUDENT';
  const events = complaint.events.map((e) => ({
    id: e.id,
    type: e.type,
    message: e.message,
    meta: e.meta,
    isInternal: e.isInternal,
    createdAt: e.createdAt,
    actorName: e.actor?.name ?? null,
  }));

  const steps = stepperFor({
    status: complaint.status,
    stamps: statusStamps(events),
    departmentName: complaint.department?.name ?? null,
    submittedAt: complaint.createdAt,
  });

  return NextResponse.json({
    complaint: {
      id: complaint.id,
      code: complaint.code,
      title: complaint.title,
      status: complaint.status,
      priority: complaint.priority,
      department: complaint.department?.name ?? null,
      location: complaint.location?.name ?? null,
      assignee: complaint.assignee?.name ?? null,
      createdAt: complaint.createdAt,
      respondedAt: complaint.respondedAt,
      resolvedAt: complaint.resolvedAt,
      closedAt: complaint.closedAt,
      reopenCount: complaint.reopenCount,
      incident: complaint.incident
        ? {
            id: complaint.incident.id,
            code: complaint.incident.code,
            status: complaint.incident.status,
            affectedCount: complaint.incident.affectedCount,
          }
        : null,
    },
    steps: steps.map((s) => ({ key: s.key, label: s.label, state: s.state, at: s.at, note: s.note ?? null })),
    updates: events
      .map(timelineEntry)
      .filter((entry) => visibleTo(entry, session.role))
      .map((entry) => ({
        at: entry.at,
        headline: entry.headline,
        detail: entry.detail,
        isInternal: entry.isInternal,
      })),
    // What this viewer may do next — the same table the buttons are built from.
    actions: isStudent
      ? []
      : nextStatuses(complaint.status, session.role).map((r) => ({
          status: r.to,
          label: r.label,
          requiresNote: Boolean(r.requiresNote),
        })),
  });
}
