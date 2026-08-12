import { prisma } from '@/lib/db';
import { syncIncidentStatus } from '@/lib/incidents/service';
import { dueDatesForDepartment } from '@/lib/sla/service';
import { canTransition, STATUS_LABEL, type TransitionActor } from './machine';
import type { ComplaintStatus, EventType } from '@/generated/prisma/enums';
import type { Prisma } from '@/generated/prisma/client';

/**
 * The **only** place a complaint's status changes (CLAUDE.md §5). A bare
 * `prisma.complaint.update({ data: { status } })` anywhere else would skip the
 * transition table and the event, and the student's tracking page would start
 * telling a story the timeline cannot back up.
 *
 * Everything that belongs to a status change happens here in one call: the
 * legality check, the column, the timestamps Layer 8 measures its SLA against,
 * the timeline event, and the incident's rolled-up status.
 */

export interface TransitionInput {
  complaintId: string;
  to: ComplaintStatus;
  actor: { id: string | null; role: TransitionActor };
  /** The sentence the student reads. Required by some rules (reject, reopen). */
  note?: string | null;
  meta?: Prisma.InputJsonObject;
  /** Column writes that are part of this same move, so they share one event. */
  assigneeId?: string | null;
  departmentId?: string | null;
}

export type TransitionOutcome =
  | {
      ok: true;
      complaintId: string;
      code: string;
      from: ComplaintStatus;
      to: ComplaintStatus;
      narration: string;
    }
  | {
      ok: false;
      code: 'NOT_FOUND' | 'ILLEGAL' | 'FORBIDDEN' | 'NOTE_REQUIRED';
      reason: string;
      allowed: ComplaintStatus[];
    };

export async function transition(input: TransitionInput): Promise<TransitionOutcome> {
  const complaint = await prisma.complaint.findUnique({
    where: { id: input.complaintId },
    select: {
      id: true,
      code: true,
      status: true,
      incidentId: true,
      respondedAt: true,
      departmentId: true,
      // Layer 8: the band and the current promise, so the SLA clock can be
      // started, restarted or torn up as part of the same move.
      priority: true,
      responseDueAt: true,
      resolutionDueAt: true,
    },
  });
  if (!complaint) {
    return { ok: false, code: 'NOT_FOUND', reason: 'Complaint not found', allowed: [] };
  }

  const from = complaint.status;
  if (from === input.to) {
    return {
      ok: false,
      code: 'ILLEGAL',
      reason: `already ${STATUS_LABEL[from].toLowerCase()}`,
      allowed: [],
    };
  }

  const check = canTransition(from, input.to, input.actor.role, input.note);
  if (!check.ok) {
    return { ok: false, code: check.code, reason: check.reason, allowed: check.allowed };
  }

  const now = new Date();
  const stamps: {
    respondedAt?: Date | null;
    resolvedAt?: Date | null;
    closedAt?: Date | null;
    reopenCount?: { increment: number };
    responseDueAt?: Date | null;
    resolutionDueAt?: Date | null;
    escalationLevel?: number;
  } = {};

  // `respondedAt` is the moment a human first took the complaint on. Layer 8's
  // response SLA is measured against it, which is why the table forbids the
  // ASSIGNED → IN_PROGRESS shortcut that would leave it unset.
  if (!complaint.respondedAt && (input.to === 'ACKNOWLEDGED' || input.to === 'IN_PROGRESS')) {
    stamps.respondedAt = now;
  }
  if (input.to === 'RESOLVED') stamps.resolvedAt = now;
  if (input.to === 'CLOSED') stamps.closedAt = now;
  if (input.to === 'REOPENED') {
    // The old resolution is no longer true, and Layer 9 counts reopens.
    stamps.resolvedAt = null;
    stamps.closedAt = null;
    stamps.reopenCount = { increment: 1 };
    // §23's reopen re-flags the department, which means a fresh promise: the
    // complaint has to be answered and fixed again, and it should not still be
    // wearing the escalations of the round that ended in a resolution the
    // student rejected. The new clock is stamped when it next reaches a
    // department (below), or on the spot if it goes straight back into work.
    stamps.respondedAt = null;
    stamps.responseDueAt = null;
    stamps.resolutionDueAt = null;
    stamps.escalationLevel = 0;
  }

  // §22's clock starts when a complaint lands on a department's desk. ASSIGNED
  // always (re)starts it — a hand-routed triage case and a reassigned reopen are
  // both a department taking the complaint on for the first time. ACKNOWLEDGED
  // and IN_PROGRESS only fill a gap: REOPENED → IN_PROGRESS skips ASSIGNED, and
  // complaints from before this layer have no due dates at all.
  const departmentId = input.departmentId !== undefined ? input.departmentId : complaint.departmentId;
  const undated = complaint.responseDueAt == null && complaint.resolutionDueAt == null;
  const startsClock =
    input.to === 'ASSIGNED' ||
    ((input.to === 'ACKNOWLEDGED' || input.to === 'IN_PROGRESS') && undated);

  if (startsClock) {
    const due = await dueDatesForDepartment(departmentId, complaint.priority, now);
    if (due) {
      stamps.responseDueAt = due.responseDueAt;
      stamps.resolutionDueAt = due.resolutionDueAt;
      // A complaint whose clock has just been restarted is nobody's failure yet.
      if (input.to === 'ASSIGNED') stamps.escalationLevel = 0;
    }
  }

  await prisma.complaint.update({
    where: { id: complaint.id },
    data: {
      status: input.to,
      ...stamps,
      ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}),
      // Routing a triage case by hand is a decision, not a doubt any more.
      ...(input.departmentId !== undefined
        ? { departmentId: input.departmentId, needsTriage: false }
        : {}),
    },
  });

  await prisma.complaintEvent.create({
    data: {
      complaintId: complaint.id,
      type: 'STATUS_CHANGED',
      actorId: input.actor.id,
      message: input.note?.trim() || null,
      meta: {
        from,
        to: input.to,
        // The feed reads this rather than the enum, so §20's timeline says
        // "Investigation started" instead of "IN_PROGRESS".
        narration: check.rule.narration,
        actorRole: input.actor.role,
        ...(input.meta ?? {}),
      },
    },
  });

  // Every complaint has exactly one incident (plan.MD §6), so this always has
  // something to update — a size-1 incident simply mirrors its only member.
  if (complaint.incidentId) await syncIncidentStatus(complaint.incidentId);

  return {
    ok: true,
    complaintId: complaint.id,
    code: complaint.code,
    from,
    to: input.to,
    narration: check.rule.narration,
  };
}

/**
 * Record something that happened to a complaint without moving it — a progress
 * update, an information request, a reassignment. Same timeline, same rules
 * about who may see it; the status simply did not change.
 */
export async function recordEvent(input: {
  complaintId: string;
  /**
   * Anything except the two this module owns: `STATUS_CHANGED` belongs to
   * `transition()` above, and `CREATED` is written once, by the submission that
   * creates the complaint row.
   */
  type: Exclude<EventType, 'STATUS_CHANGED' | 'CREATED'>;
  actorId: string | null;
  message: string;
  isInternal?: boolean;
  meta?: Prisma.InputJsonObject;
}) {
  return prisma.complaintEvent.create({
    data: {
      complaintId: input.complaintId,
      type: input.type,
      actorId: input.actorId,
      message: input.message,
      isInternal: input.isInternal ?? false,
      meta: input.meta ?? {},
    },
  });
}
