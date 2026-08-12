import { prisma } from '@/lib/db';
import { syncIncidentStatus } from '@/lib/incidents/service';
import { canTransition, STATUS_LABEL, type TransitionActor } from './machine';
import type { ComplaintStatus } from '@/generated/prisma/enums';
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
    respondedAt?: Date;
    resolvedAt?: Date | null;
    closedAt?: Date | null;
    reopenCount?: { increment: number };
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
  type: 'PROGRESS_UPDATE' | 'INFO_REQUESTED' | 'INFO_PROVIDED' | 'ASSIGNED' | 'COMMENT';
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
