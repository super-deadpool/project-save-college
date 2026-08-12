import { prisma } from '@/lib/db';
import { transition } from '@/lib/lifecycle/transition';
import { pathTo, type TransitionActor } from '@/lib/lifecycle/machine';
import type { ComplaintStatus } from '@/generated/prisma/enums';

/**
 * §17's payoff: one fix, one action, forty students told. Staff act on the
 * incident and every member complaint moves — each through `transition()`, so
 * each gets its own legality check and its own timeline entry. The incident
 * itself has no status of its own to write; it is recomputed from the members
 * afterwards, which is what makes the two directions agree.
 *
 * A member that legally cannot make the move is **skipped and reported**, not
 * forced. A complaint already closed by its own reporter is not reopened by a
 * bulk resolve, and staff are told which ones did not move.
 */
export interface IncidentActionResult {
  applied: { id: string; code: string; from: ComplaintStatus; to: ComplaintStatus }[];
  skipped: { id: string; code: string; reason: string }[];
}

export async function applyIncidentStatus(input: {
  incidentId: string;
  to: ComplaintStatus;
  actor: { id: string | null; role: TransitionActor };
  note?: string | null;
  /** Non-admins act only on their own department's members (§21). */
  scopeDepartmentId?: string | null;
}): Promise<{ error: 'Incident not found' } | IncidentActionResult> {
  const incident = await prisma.incident.findUnique({
    where: { id: input.incidentId },
    select: {
      code: true,
      complaints: {
        orderBy: { createdAt: 'asc' },
        select: { id: true, code: true, status: true, departmentId: true },
      },
    },
  });
  if (!incident) return { error: 'Incident not found' };

  const result: IncidentActionResult = { applied: [], skipped: [] };

  for (const member of incident.complaints) {
    if (
      input.scopeDepartmentId != null &&
      member.departmentId !== input.scopeDepartmentId
    ) {
      result.skipped.push({ id: member.id, code: member.code, reason: 'another department' });
      continue;
    }

    // Members sit at different rungs — one accepted, thirty untouched — so the
    // move is walked rather than forced. Every rung is a real transition with
    // its own event, which is why `respondedAt` is still stamped on a complaint
    // that went from assigned to resolved in one click.
    const path = pathTo(member.status, input.to, input.actor.role);
    if (path === null) {
      result.skipped.push({
        id: member.id,
        code: member.code,
        reason: `${member.status} cannot reach ${input.to}`,
      });
      continue;
    }
    if (path.length === 0) {
      result.skipped.push({ id: member.id, code: member.code, reason: 'already there' });
      continue;
    }

    const from = member.status;
    let failed: string | null = null;

    for (const [index, rule] of path.entries()) {
      const outcome = await transition({
        complaintId: member.id,
        to: rule.to,
        actor: input.actor,
        // The reason belongs to the move that was actually asked for.
        note: index === path.length - 1 ? input.note : null,
        // The member's timeline says where the decision came from, so a student
        // reading their own complaint can see it moved with the wider incident.
        meta: { viaIncident: incident.code },
      });
      if (!outcome.ok) {
        failed = outcome.reason;
        break;
      }
    }

    if (failed) result.skipped.push({ id: member.id, code: member.code, reason: failed });
    else result.applied.push({ id: member.id, code: member.code, from, to: input.to });
  }

  return result;
}
