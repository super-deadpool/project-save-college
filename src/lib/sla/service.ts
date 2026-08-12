import { prisma } from '@/lib/db';
import { SETTLED_STATUSES } from '@/lib/lifecycle/machine';
import { describeMinutes, dueDatesFrom, minutesBetween, windowFor, type SlaDueDates } from './due';
import { escalationPlan, slaState, type EscalationStep, type SlaRow } from './breach';
import type { Priority } from '@/generated/prisma/enums';

/**
 * The impure half of Layer 8: it loads rows, and it writes the two things an
 * escalation consists of — the fact that a promise was broken, and the person it
 * was handed to. Every judgement it makes comes from `sla/due.ts` and
 * `sla/breach.ts`, so this file has no thresholds of its own.
 *
 * `transition()` calls `dueDatesForDepartment` when a complaint reaches a
 * department; the worker calls `scanSla` once a minute.
 */

/**
 * The promise a complaint picks up when it lands on a department's desk. Null
 * when there is no department yet — §15's triage case has nobody to promise
 * anything, and inventing a deadline for an unrouted complaint would make the
 * queue's SLA column fiction.
 */
export async function dueDatesForDepartment(
  departmentId: string | null,
  band: Priority,
  from: Date,
): Promise<SlaDueDates | null> {
  if (!departmentId) return null;

  const department = await prisma.department.findUnique({
    where: { id: departmentId },
    select: { slaProfile: true },
  });

  // A department with no profile attached still gets `DEFAULT_SLA` (see due.ts).
  return dueDatesFrom(from, department?.slaProfile ?? null, band);
}

export interface EscalationApplied {
  complaintId: string;
  code: string;
  from: number;
  to: number;
  steps: EscalationStep[];
}

export interface SlaScanResult {
  now: Date;
  /** Complaints with a live promise that were examined. */
  scanned: number;
  /** How many are past a deadline right now, escalated or not. */
  breaching: number;
  escalated: EscalationApplied[];
}

/**
 * One sweep of §22's ladder.
 *
 * Idempotent by construction: a complaint is only moved *up* from the rung it is
 * already recorded on (`escalationLevel`), so running this every minute writes
 * an event the first time a deadline passes and nothing on the next fifty-nine
 * scans. That is also what makes the ladder safe to run from two places — the
 * cron worker and the dev endpoint — without double-reporting.
 */
export async function scanSla(
  options: { now?: Date; complaintId?: string; departmentId?: string } = {},
): Promise<SlaScanResult> {
  const now = options.now ?? new Date();

  const candidates = await prisma.complaint.findMany({
    where: {
      status: { notIn: SETTLED_STATUSES },
      ...(options.complaintId ? { id: options.complaintId } : {}),
      ...(options.departmentId ? { departmentId: options.departmentId } : {}),
      // A complaint with no due dates has no promise to break — Layer 6's rows
      // and anything still awaiting triage.
      OR: [{ responseDueAt: { not: null } }, { resolutionDueAt: { not: null } }],
    },
    select: {
      id: true,
      code: true,
      title: true,
      status: true,
      priority: true,
      createdAt: true,
      departmentId: true,
      responseDueAt: true,
      resolutionDueAt: true,
      respondedAt: true,
      resolvedAt: true,
      escalationLevel: true,
    },
  });

  const escalated: EscalationApplied[] = [];
  let breaching = 0;
  const recipients = new Map<string, { id: string; name: string } | null>();

  for (const complaint of candidates) {
    const state = slaState(complaint as SlaRow, now);
    if (state.level > 0) breaching += 1;

    const plan = escalationPlan(state, complaint.escalationLevel);
    if (plan.length === 0) continue;

    for (const step of plan) {
      const to = await escalationRecipient(step, complaint.departmentId, recipients);
      const overdueBy = overdueDescription(complaint, step, now);

      // Two events, because two different things happened: a promise was broken,
      // and somebody was made responsible for it. The feed reads them as cause
      // and consequence, and it words both headlines from `meta`
      // (`lifecycle/timeline.ts`) — so each message carries only what the
      // headline does not already say.
      await prisma.complaintEvent.create({
        data: {
          complaintId: complaint.id,
          type: 'SLA_BREACHED',
          actorId: null,
          message: promiseNote(complaint, step, overdueBy),
          meta: { kind: step.kind, level: step.level, priority: complaint.priority },
        },
      });

      await prisma.complaintEvent.create({
        data: {
          complaintId: complaint.id,
          type: 'ESCALATED',
          actorId: null,
          message: step.reason,
          meta: {
            level: step.level,
            kind: step.kind,
            notify: step.notify,
            notifyUserId: to?.id ?? null,
            notifyName: to?.name ?? null,
            // §22's last rung marks the complaint as well as telling the admin.
            // `escalationLevel >= 3` *is* the flag — see plan.MD §7 Layer 8.
            flagged: step.flagged,
          },
        },
      });
    }

    const reached = plan.at(-1)!.level;
    await prisma.complaint.update({
      where: { id: complaint.id },
      data: { escalationLevel: reached },
    });

    escalated.push({
      complaintId: complaint.id,
      code: complaint.code,
      from: complaint.escalationLevel,
      to: reached,
      steps: plan,
    });
  }

  return { now, scanned: candidates.length, breaching, escalated };
}

/**
 * Who the rung hands the complaint to. The manager of the department that owns
 * it, or any administrator; the escalation is recorded either way, because "no
 * manager is configured" is not a reason to let a breach go unwritten.
 */
async function escalationRecipient(
  step: EscalationStep,
  departmentId: string | null,
  cache: Map<string, { id: string; name: string } | null>,
): Promise<{ id: string; name: string } | null> {
  const key = step.notify === 'ADMIN' ? 'ADMIN' : `MGR:${departmentId ?? 'none'}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const found =
    step.notify === 'ADMIN'
      ? await prisma.user.findFirst({
          where: { role: 'ADMIN', isActive: true },
          select: { id: true, name: true },
          orderBy: { createdAt: 'asc' },
        })
      : departmentId
        ? await prisma.user.findFirst({
            where: { role: 'DEPT_MANAGER', isActive: true, departmentId },
            select: { id: true, name: true },
            orderBy: { createdAt: 'asc' },
          })
        : null;

  cache.set(key, found);
  return found;
}

/**
 * "Promised in 1 h — overdue by 5 min": the window that was given and the amount
 * it was missed by. The headline already names *which* promise broke, so this
 * says only how badly.
 */
function promiseNote(
  complaint: { createdAt: Date; responseDueAt: Date | null; resolutionDueAt: Date | null },
  step: EscalationStep,
  overdueBy: string | null,
): string {
  const due = step.kind === 'RESPONSE' ? complaint.responseDueAt : complaint.resolutionDueAt;
  const promised = due ? describeMinutes(minutesBetween(complaint.createdAt, due)) : null;
  const window =
    promised == null
      ? null
      : step.kind === 'RESOLUTION_2X'
        ? `Promised in ${promised}, and twice that has now gone by`
        : `Promised in ${promised}`;

  return [window, overdueBy ? `overdue by ${overdueBy}` : null].filter(Boolean).join(' — ');
}

/** "overdue by 2 h" — the number the manager actually wants in the message. */
function overdueDescription(
  complaint: { responseDueAt: Date | null; resolutionDueAt: Date | null; createdAt: Date; priority: Priority },
  step: EscalationStep,
  now: Date,
): string | null {
  if (step.kind === 'RESPONSE') {
    return complaint.responseDueAt ? describeMinutes(minutesBetween(complaint.responseDueAt, now)) : null;
  }
  if (!complaint.resolutionDueAt) return null;
  if (step.kind === 'RESOLUTION') {
    return describeMinutes(minutesBetween(complaint.resolutionDueAt, now));
  }
  // The doubled deadline, expressed as the window it doubled.
  const doubled = new Date(2 * complaint.resolutionDueAt.getTime() - complaint.createdAt.getTime());
  return describeMinutes(minutesBetween(doubled, now));
}

/**
 * The promise, in the words the staff panel uses: "60 min to respond, 1 d to
 * resolve". Reads the same profile the due dates were stamped from, so the panel
 * cannot describe a window the complaint was never held to.
 */
export async function describeSlaPromise(departmentId: string | null, band: Priority): Promise<string | null> {
  if (!departmentId) return null;
  const department = await prisma.department.findUnique({
    where: { id: departmentId },
    select: { slaProfile: true },
  });
  const window = windowFor(department?.slaProfile ?? null, band);
  return `${describeMinutes(window.responseMinutes)} to respond · ${describeMinutes(window.resolutionMinutes)} to resolve`;
}
