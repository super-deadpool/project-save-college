import type { ComplaintStatus } from '@/generated/prisma/enums';
import { isSettled } from '@/lib/lifecycle/machine';

/**
 * §22's other half: who a forgotten complaint goes to next.
 *
 *     Staff → Department Manager → Administrator
 *
 * Pure (CLAUDE.md §5). `sla/service.ts` loads the rows and writes the events;
 * every decision about *whether* something is late, and what that means, is
 * here so it can be pinned by a test with synthetic dates instead of by waiting
 * an hour for a real one.
 */

/** The subset of `Complaint` the ladder reads. Deliberately the queue's shape plus two columns. */
export interface SlaRow {
  status: ComplaintStatus;
  createdAt: Date;
  responseDueAt: Date | null;
  resolutionDueAt: Date | null;
  respondedAt: Date | null;
  resolvedAt: Date | null;
  escalationLevel: number;
}

export type BreachKind = 'RESPONSE' | 'RESOLUTION' | 'RESOLUTION_2X';

export interface SlaState {
  /** Nobody acknowledged it inside the response window. */
  responseBreached: boolean;
  /** It is still unresolved past its resolution deadline. */
  resolutionBreached: boolean;
  /** Twice its resolution window has gone by (§22's last rung). */
  resolutionBreachedTwice: boolean;
  /** The rung §22 says this complaint should be on: 0 when nothing is late. */
  level: 0 | 1 | 2 | 3;
  /** The most serious breach, for the badge and the event message. */
  worst: BreachKind | null;
}

export type EscalationTarget = 'DEPT_MANAGER' | 'ADMIN';

export interface EscalationStep {
  level: 1 | 2 | 3;
  kind: BreachKind;
  notify: EscalationTarget;
  /** §22's last rung: the admin is told *and* the complaint is flagged. */
  flagged: boolean;
  /** The sentence written into the timeline event. */
  reason: string;
}

/**
 * The ladder itself. One rung per kind of failure, in the order they can happen:
 * a missed response is the department manager's problem, a missed repair is the
 * administration's, and a repair that has taken twice as long as promised is
 * both told and marked so it cannot drop out of sight again.
 */
export const ESCALATION_LADDER: EscalationStep[] = [
  {
    level: 1,
    kind: 'RESPONSE',
    notify: 'DEPT_MANAGER',
    flagged: false,
    reason: 'No response inside the response window',
  },
  {
    level: 2,
    kind: 'RESOLUTION',
    notify: 'ADMIN',
    flagged: false,
    reason: 'Still unresolved past the resolution deadline',
  },
  {
    level: 3,
    kind: 'RESOLUTION_2X',
    notify: 'ADMIN',
    flagged: true,
    reason: 'Twice the resolution window has passed',
  },
];

/**
 * Where a complaint stands against its promises, right now.
 *
 * A settled complaint has nothing live to breach: work that is finished cannot
 * be escalated to anybody, and re-escalating yesterday's resolved complaint
 * every minute is exactly the noise that makes an escalation ladder ignorable.
 * Whether it *was* late is a different question — `slaOutcome()` below.
 */
export function slaState(row: SlaRow, now: Date): SlaState {
  if (isSettled(row.status)) {
    return {
      responseBreached: false,
      resolutionBreached: false,
      resolutionBreachedTwice: false,
      level: 0,
      worst: null,
    };
  }

  const responseBreached =
    row.respondedAt == null && row.responseDueAt != null && now.getTime() >= row.responseDueAt.getTime();

  const resolutionBreached =
    row.resolvedAt == null &&
    row.resolutionDueAt != null &&
    now.getTime() >= row.resolutionDueAt.getTime();

  // Twice the window, measured from the same instant the window itself started.
  // The due dates are stamped on assignment, seconds after submission, so
  // `createdAt` is that instant — and using it keeps this row shape free of a
  // column that would only exist to answer this one question.
  const doubled =
    row.resolutionDueAt != null
      ? new Date(2 * row.resolutionDueAt.getTime() - row.createdAt.getTime())
      : null;
  const resolutionBreachedTwice =
    resolutionBreached && doubled != null && now.getTime() >= doubled.getTime();

  const level: SlaState['level'] = resolutionBreachedTwice
    ? 3
    : resolutionBreached
      ? 2
      : responseBreached
        ? 1
        : 0;

  return {
    responseBreached,
    resolutionBreached,
    resolutionBreachedTwice,
    level,
    worst: resolutionBreachedTwice
      ? 'RESOLUTION_2X'
      : resolutionBreached
        ? 'RESOLUTION'
        : responseBreached
          ? 'RESPONSE'
          : null,
  };
}

/**
 * The rungs still to climb — what the scan actually applies.
 *
 * A rung is only walked when its own failure really happened. A complaint that
 * was acknowledged in two minutes and then sat unrepaired for a week goes
 * straight from 0 to 2: writing a "nobody responded" escalation on the way past
 * would put a failure in the timeline that never occurred.
 */
export function escalationPlan(state: SlaState, currentLevel: number): EscalationStep[] {
  return ESCALATION_LADDER.filter((step) => step.level > currentLevel && holds(state, step.kind));
}

function holds(state: SlaState, kind: BreachKind): boolean {
  switch (kind) {
    case 'RESPONSE':
      return state.responseBreached;
    case 'RESOLUTION':
      return state.resolutionBreached;
    case 'RESOLUTION_2X':
      return state.resolutionBreachedTwice;
  }
}

/** §22's ladder in one line, for the escalation badge: "escalated to the admin". */
export const TARGET_LABEL: Record<EscalationTarget, string> = {
  DEPT_MANAGER: 'the department manager',
  ADMIN: 'the campus administrator',
};

/**
 * Whether the promises were kept, for a complaint that is over. Unlike
 * `slaState` this ignores `now` — it reads the stamps, which is what makes it
 * answerable for a complaint closed last month. `null` means the question does
 * not apply yet: no due date was ever set, or the stamp has not happened.
 *
 * The dashboards aggregate this in SQL (`analytics/sql.ts`); this is the
 * row-level version behind the staff panel, and the two must agree.
 */
export function slaOutcome(row: SlaRow): { responseMet: boolean | null; resolutionMet: boolean | null } {
  const responseMet =
    row.responseDueAt == null
      ? null
      : row.respondedAt == null
        ? null
        : row.respondedAt.getTime() <= row.responseDueAt.getTime();

  const resolutionMet =
    row.resolutionDueAt == null
      ? null
      : row.resolvedAt == null
        ? null
        : row.resolvedAt.getTime() <= row.resolutionDueAt.getTime();

  return { responseMet, resolutionMet };
}
