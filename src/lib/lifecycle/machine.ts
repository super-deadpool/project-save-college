import type { ComplaintStatus, Role } from '@/generated/prisma/enums';

/**
 * The complaint lifecycle, spec §19 / plan.MD §7 Layer 6.
 *
 * One table, one meaning: a status change that is not in `TRANSITIONS` cannot
 * happen. Everything that moves a complaint — the automatic path at submission,
 * a staff button, an incident-wide resolve, a student confirming a fix — is
 * checked against this file first, which is what keeps the timeline a true
 * record rather than a log of whatever the last writer felt like.
 *
 * Pure by design (CLAUDE.md §5): no Prisma, no clock. `lifecycle/transition.ts`
 * is the impure half that persists a move this file has already blessed.
 */

/** Who is driving a transition. `SYSTEM` is the automatic path — no person. */
export type TransitionActor = Role | 'SYSTEM';

export interface TransitionRule {
  from: ComplaintStatus;
  to: ComplaintStatus;
  /** Roles permitted to drive it. Department scoping is the caller's job. */
  actors: TransitionActor[];
  /** Imperative, for the staff button: "Accept", "Start work", "Resolve". */
  label: string;
  /** Past tense, for the timeline: "Investigation started". */
  narration: string;
  /** True when the move is meaningless without a sentence explaining it. */
  requiresNote?: boolean;
}

const STAFF: TransitionActor[] = ['STAFF', 'DEPT_MANAGER', 'ADMIN'];
const MANAGER: TransitionActor[] = ['DEPT_MANAGER', 'ADMIN'];

/**
 * §19's ladder, plus the branches off it.
 *
 * The ladder is deliberately strict: ASSIGNED cannot jump straight to
 * IN_PROGRESS. A complaint reaches IN_PROGRESS only through ACKNOWLEDGED, which
 * is the moment `respondedAt` is stamped — and Layer 8's response-SLA is
 * measured against exactly that stamp. Allowing the shortcut would leave a
 * worked-on complaint with no response time at all.
 */
export const TRANSITIONS: TransitionRule[] = [
  // The automatic path at submission. Analysis has in fact already run by the
  // time a complaint row exists (assess.ts), so these two are stamped rather
  // than awaited — but they are still transitions, so they still leave events.
  { from: 'SUBMITTED', to: 'ANALYZING', actors: ['SYSTEM', 'ADMIN'], label: 'Analyze', narration: 'Analyzed' },
  {
    from: 'ANALYZING',
    to: 'ASSIGNED',
    // Routing usually does this in the same breath; a human does it when
    // confidence was too low to route automatically (§15).
    actors: ['SYSTEM', ...STAFF],
    label: 'Assign to a department',
    narration: 'Assigned to a department',
  },
  { from: 'ANALYZING', to: 'REJECTED', actors: MANAGER, label: 'Reject', narration: 'Rejected', requiresNote: true },

  { from: 'ASSIGNED', to: 'ACKNOWLEDGED', actors: STAFF, label: 'Accept', narration: 'Acknowledged by staff' },
  { from: 'ASSIGNED', to: 'REJECTED', actors: MANAGER, label: 'Reject', narration: 'Rejected', requiresNote: true },
  { from: 'ASSIGNED', to: 'DUPLICATE', actors: STAFF, label: 'Mark duplicate', narration: 'Marked as a duplicate' },

  { from: 'ACKNOWLEDGED', to: 'IN_PROGRESS', actors: STAFF, label: 'Start work', narration: 'Investigation started' },
  {
    from: 'ACKNOWLEDGED',
    to: 'WAITING_FOR_STUDENT',
    actors: STAFF,
    label: 'Request information',
    // The question itself is an INFO_REQUESTED event immediately before this
    // one, so the status change says what changed rather than repeating it.
    narration: 'Waiting for a reply',
    requiresNote: true,
  },
  { from: 'ACKNOWLEDGED', to: 'RESOLVED', actors: STAFF, label: 'Resolve', narration: 'Marked resolved' },
  { from: 'ACKNOWLEDGED', to: 'REJECTED', actors: MANAGER, label: 'Reject', narration: 'Rejected', requiresNote: true },
  { from: 'ACKNOWLEDGED', to: 'DUPLICATE', actors: STAFF, label: 'Mark duplicate', narration: 'Marked as a duplicate' },

  {
    from: 'IN_PROGRESS',
    to: 'WAITING_FOR_STUDENT',
    actors: STAFF,
    label: 'Request information',
    // The question itself is an INFO_REQUESTED event immediately before this
    // one, so the status change says what changed rather than repeating it.
    narration: 'Waiting for a reply',
    requiresNote: true,
  },
  { from: 'IN_PROGRESS', to: 'RESOLVED', actors: STAFF, label: 'Resolve', narration: 'Marked resolved' },
  { from: 'IN_PROGRESS', to: 'REJECTED', actors: MANAGER, label: 'Reject', narration: 'Rejected', requiresNote: true },
  { from: 'IN_PROGRESS', to: 'DUPLICATE', actors: STAFF, label: 'Mark duplicate', narration: 'Marked as a duplicate' },

  // The student is the one who can end the wait, so they drive this one.
  {
    from: 'WAITING_FOR_STUDENT',
    to: 'IN_PROGRESS',
    actors: ['STUDENT', ...STAFF],
    label: 'Resume work',
    narration: 'Work resumed',
  },
  { from: 'WAITING_FOR_STUDENT', to: 'RESOLVED', actors: STAFF, label: 'Resolve', narration: 'Marked resolved' },
  {
    from: 'WAITING_FOR_STUDENT',
    to: 'REJECTED',
    actors: MANAGER,
    label: 'Reject',
    narration: 'Rejected',
    requiresNote: true,
  },

  // Layer 9 owns the student-facing confirmation UI; the table already permits
  // the two moves it will make, so that layer adds screens, not rules.
  {
    from: 'RESOLVED',
    to: 'CLOSED',
    actors: ['STUDENT', 'SYSTEM', ...STAFF],
    label: 'Close',
    narration: 'Closed',
  },
  {
    from: 'RESOLVED',
    to: 'REOPENED',
    actors: ['STUDENT', ...STAFF],
    label: 'Reopen',
    narration: 'Reopened — the issue was not fixed',
    requiresNote: true,
  },
  {
    from: 'CLOSED',
    to: 'REOPENED',
    actors: ['STUDENT', ...STAFF],
    label: 'Reopen',
    narration: 'Reopened',
    requiresNote: true,
  },

  { from: 'REOPENED', to: 'ASSIGNED', actors: STAFF, label: 'Reassign', narration: 'Reassigned' },
  { from: 'REOPENED', to: 'ACKNOWLEDGED', actors: STAFF, label: 'Accept', narration: 'Acknowledged by staff' },
  { from: 'REOPENED', to: 'IN_PROGRESS', actors: STAFF, label: 'Start work', narration: 'Investigation restarted' },

  { from: 'REJECTED', to: 'REOPENED', actors: MANAGER, label: 'Reopen', narration: 'Reopened', requiresNote: true },
];

export const STATUS_LABEL: Record<ComplaintStatus, string> = {
  SUBMITTED: 'Submitted',
  ANALYZING: 'Analyzing',
  ASSIGNED: 'Assigned',
  ACKNOWLEDGED: 'Acknowledged',
  IN_PROGRESS: 'In progress',
  WAITING_FOR_STUDENT: 'Waiting for you',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
  REOPENED: 'Reopened',
  REJECTED: 'Rejected',
  DUPLICATE: 'Duplicate',
};

/** Nothing more will happen here on its own. `CLOSED` is reopenable, not dead. */
const TERMINAL: ComplaintStatus[] = ['CLOSED', 'REJECTED', 'DUPLICATE'];

/**
 * Work is finished — used by the queue to sink a row, by the incident rollup, and
 * by Layer 8 to decide there is no live promise left to break. Exported as a list
 * as well as a predicate so a database query can ask the same question without
 * re-listing the statuses itself.
 */
export const SETTLED_STATUSES: ComplaintStatus[] = ['RESOLVED', ...TERMINAL];

export function isSettled(status: ComplaintStatus): boolean {
  return SETTLED_STATUSES.includes(status);
}

/** Someone in the department has the complaint in hand. */
export function isActive(status: ComplaintStatus): boolean {
  return status === 'ACKNOWLEDGED' || status === 'IN_PROGRESS' || status === 'WAITING_FOR_STUDENT';
}

export function findRule(from: ComplaintStatus, to: ComplaintStatus): TransitionRule | null {
  return TRANSITIONS.find((r) => r.from === from && r.to === to) ?? null;
}

export type TransitionCheck =
  | { ok: true; rule: TransitionRule }
  | { ok: false; code: 'ILLEGAL' | 'FORBIDDEN' | 'NOTE_REQUIRED'; reason: string; allowed: ComplaintStatus[] };

/**
 * The single question every writer asks: may this actor move this complaint
 * from here to there? The answer carries the legal alternatives so an API can
 * tell a caller what it *could* have done instead of only what it may not.
 */
export function canTransition(
  from: ComplaintStatus,
  to: ComplaintStatus,
  actor: TransitionActor,
  note?: string | null,
): TransitionCheck {
  const allowed = nextStatuses(from, actor).map((r) => r.to);
  const rule = findRule(from, to);

  if (!rule) {
    return {
      ok: false,
      code: 'ILLEGAL',
      reason: `${STATUS_LABEL[from]} cannot become ${STATUS_LABEL[to]}`,
      allowed,
    };
  }
  if (!rule.actors.includes(actor)) {
    return {
      ok: false,
      code: 'FORBIDDEN',
      reason: `${actor.toLowerCase().replace('_', ' ')} may not ${rule.label.toLowerCase()} this complaint`,
      allowed,
    };
  }
  if (rule.requiresNote && !note?.trim()) {
    return {
      ok: false,
      code: 'NOTE_REQUIRED',
      reason: `"${rule.label}" needs a reason the student can read`,
      allowed,
    };
  }
  return { ok: true, rule };
}

/** Every move this actor may make from here — what the staff panel renders. */
export function nextStatuses(from: ComplaintStatus, actor: TransitionActor): TransitionRule[] {
  return TRANSITIONS.filter((r) => r.from === from && r.actors.includes(actor));
}

/**
 * The shortest legal route from one status to another, or null when there is
 * none. Used only by the incident-wide action (§17), where the intent is "get
 * all forty of these to resolved" and the members are at forty different rungs.
 *
 * A single complaint never walks a path — its buttons come from `nextStatuses`,
 * and the ladder's strictness is the point there. Walking is what lets the bulk
 * action honour that same strictness instead of being given a shortcut edge:
 * each rung is a real transition with its own event and its own timestamps.
 *
 * Intermediate steps may not be ones that demand an explanation. Being carried
 * through "rejected" on the way somewhere else is not a step anyone took.
 */
export function pathTo(
  from: ComplaintStatus,
  to: ComplaintStatus,
  actor: TransitionActor,
): TransitionRule[] | null {
  if (from === to) return [];

  const queue: { at: ComplaintStatus; path: TransitionRule[] }[] = [{ at: from, path: [] }];
  const seen = new Set<ComplaintStatus>([from]);

  while (queue.length > 0) {
    const { at, path } = queue.shift()!;
    for (const rule of nextStatuses(at, actor)) {
      if (rule.requiresNote && rule.to !== to) continue;
      if (rule.to === to) return [...path, rule];
      if (seen.has(rule.to)) continue;
      seen.add(rule.to);
      queue.push({ at: rule.to, path: [...path, rule] });
    }
  }

  return null;
}
