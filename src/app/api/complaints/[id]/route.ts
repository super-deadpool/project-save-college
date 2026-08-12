import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireApiRole } from '@/lib/auth/api';
import { nextStatuses } from '@/lib/lifecycle/machine';
import { stepperFor } from '@/lib/lifecycle/stepper';
import { statusStamps, timelineEntry, visibleTo } from '@/lib/lifecycle/timeline';
import { slaOutcome, slaState } from '@/lib/sla/breach';
import { slaRisk } from '@/lib/queue/rank';

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
      feedback: true,
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
  const now = new Date();
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
      // §22, staff-facing: which promise is live, how it stands, and which rung
      // of the ladder the complaint has reached. A student is told one thing —
      // when this is expected to be fixed — and never the internal risk state.
      sla: isStudent
        ? { expectedResolutionBy: complaint.resolutionDueAt }
        : {
            responseDueAt: complaint.responseDueAt,
            resolutionDueAt: complaint.resolutionDueAt,
            risk: slaRisk(complaint, now),
            escalationLevel: complaint.escalationLevel,
            flagged: complaint.escalationLevel >= 3,
            ...slaState(complaint, now),
            ...slaOutcome(complaint),
          },
      incident: complaint.incident
        ? {
            id: complaint.incident.id,
            code: complaint.incident.code,
            status: complaint.incident.status,
            affectedCount: complaint.incident.affectedCount,
          }
        : null,
      // §24 — what the student thought of the resolution, once they have said.
      feedback: complaint.feedback
        ? {
            rating: complaint.feedback.rating,
            comment: complaint.feedback.comment,
            resolutionConfirmed: complaint.feedback.resolutionConfirmed,
            at: complaint.feedback.createdAt,
          }
        : null,
    },
    // §23/§24 are the reporter's to answer, so the API says plainly whether this
    // viewer is being asked anything.
    asks: {
      confirmResolution: complaint.reporterId === session.sub && complaint.status === 'RESOLVED',
      rateResolution:
        complaint.reporterId === session.sub &&
        complaint.feedback == null &&
        (complaint.status === 'CLOSED' || complaint.status === 'RESOLVED'),
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
