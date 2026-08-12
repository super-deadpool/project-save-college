import type { ComplaintStatus } from '@/generated/prisma/enums';
import { STATUS_LABEL } from './machine';

/**
 * §20's tracking stepper — the thing a student actually looks at:
 *
 *   ✓ Submitted · ✓ Analyzed · ✓ Assigned to IT · ✓ Acknowledged
 *   ● In Progress · ○ Resolved · ○ Closed
 *
 * Pure: statuses and timestamps in, steps out. The timestamps come from the
 * `STATUS_CHANGED` events, so a step is only ticked because a transition really
 * happened — the stepper cannot claim progress the timeline does not show.
 */

export const LADDER: ComplaintStatus[] = [
  'SUBMITTED',
  'ANALYZING',
  'ASSIGNED',
  'ACKNOWLEDGED',
  'IN_PROGRESS',
  'RESOLVED',
  'CLOSED',
];

/** §20's wording, which is not the same as the status name: "Analyzed", not "Analyzing". */
const STEP_LABEL: Record<string, string> = {
  SUBMITTED: 'Submitted',
  ANALYZING: 'Analyzed',
  ASSIGNED: 'Assigned',
  ACKNOWLEDGED: 'Acknowledged',
  IN_PROGRESS: 'In progress',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
};

/**
 * Where each status sits on the ladder. The off-ladder states still have a
 * place: a complaint waiting on the student has not lost the progress it made,
 * and a reopened one is back with the department rather than back at the start.
 */
const RANK: Record<ComplaintStatus, number> = {
  SUBMITTED: 0,
  ANALYZING: 1,
  ASSIGNED: 2,
  ACKNOWLEDGED: 3,
  IN_PROGRESS: 4,
  WAITING_FOR_STUDENT: 4,
  RESOLVED: 5,
  CLOSED: 6,
  REOPENED: 2,
  REJECTED: -1,
  DUPLICATE: -1,
};

const NOTE: Partial<Record<ComplaintStatus, string>> = {
  WAITING_FOR_STUDENT: 'Waiting for your reply',
  REOPENED: 'Reopened — back with the department',
};

export type StepState = 'DONE' | 'CURRENT' | 'PENDING';

export interface Step {
  key: string;
  label: string;
  state: StepState;
  at: Date | null;
  note?: string;
}

export interface StepperInput {
  status: ComplaintStatus;
  /** When each status was entered — from the STATUS_CHANGED events. */
  stamps: Partial<Record<ComplaintStatus, Date>>;
  /** "Assigned to IT" reads better than "Assigned" (§20's example). */
  departmentName?: string | null;
  /** The complaint's own creation time, which is the Submitted step. */
  submittedAt: Date;
}

export function stepperFor(input: StepperInput): Step[] {
  const { status, stamps, submittedAt } = input;
  const current = RANK[status];

  const stampFor = (key: ComplaintStatus): Date | null =>
    key === 'SUBMITTED' ? (stamps.SUBMITTED ?? submittedAt) : (stamps[key] ?? null);

  // Rejected and duplicate leave the ladder: show what genuinely happened, then
  // one final step saying where it stopped. Pretending the ladder continues
  // would promise a resolution that is not coming.
  if (current < 0) {
    const reachedTo = highestReached(stamps);
    const steps: Step[] = LADDER.filter((key) => RANK[key] <= reachedTo).map((key) => ({
      key,
      label: labelFor(key, input),
      state: 'DONE' as const,
      at: stampFor(key),
    }));
    steps.push({
      key: status,
      label: STATUS_LABEL[status],
      state: 'CURRENT',
      at: stamps[status] ?? null,
    });
    return steps;
  }

  return LADDER.map((key) => {
    const rank = RANK[key];
    const state: StepState = rank < current ? 'DONE' : rank === current ? 'CURRENT' : 'PENDING';
    return {
      key,
      label: labelFor(key, input),
      state,
      // A reopened complaint has an old RESOLVED stamp. Showing it against a
      // step the complaint has fallen back behind would read as still resolved.
      at: state === 'PENDING' ? null : stampFor(key),
      ...(state === 'CURRENT' && NOTE[status] ? { note: NOTE[status] } : {}),
    };
  });
}

function labelFor(key: ComplaintStatus, input: StepperInput): string {
  if (key === 'ASSIGNED' && input.departmentName) return `Assigned to ${input.departmentName}`;
  return STEP_LABEL[key] ?? STATUS_LABEL[key];
}

function highestReached(stamps: Partial<Record<ComplaintStatus, Date>>): number {
  let best = 0;
  for (const key of Object.keys(stamps) as ComplaintStatus[]) {
    if (stamps[key] && RANK[key] > best) best = RANK[key];
  }
  return best;
}
