import { describe, expect, it } from 'vitest';
import {
  canTransition,
  findRule,
  isActive,
  isSettled,
  nextStatuses,
  pathTo,
  STATUS_LABEL,
  TRANSITIONS,
} from '@/lib/lifecycle/machine';
import type { ComplaintStatus } from '@/generated/prisma/enums';

describe('the §19 ladder', () => {
  it('walks Submitted → Analyzing → Assigned → Acknowledged → In progress → Resolved → Closed', () => {
    const ladder: ComplaintStatus[] = [
      'SUBMITTED',
      'ANALYZING',
      'ASSIGNED',
      'ACKNOWLEDGED',
      'IN_PROGRESS',
      'RESOLVED',
      'CLOSED',
    ];
    for (let i = 0; i < ladder.length - 1; i++) {
      expect(findRule(ladder[i], ladder[i + 1]), `${ladder[i]} → ${ladder[i + 1]}`).not.toBeNull();
    }
  });

  it('refuses the ASSIGNED → IN_PROGRESS shortcut', () => {
    // Work only starts through ACKNOWLEDGED, which is where `respondedAt` is
    // stamped — the stamp Layer 8's response SLA is measured against. The
    // shortcut would leave a worked-on complaint with no response time at all.
    const check = canTransition('ASSIGNED', 'IN_PROGRESS', 'STAFF');
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.code).toBe('ILLEGAL');
      expect(check.allowed).toContain('ACKNOWLEDGED');
    }
  });

  it('rejects a move that skips the middle of the ladder entirely', () => {
    expect(canTransition('SUBMITTED', 'RESOLVED', 'ADMIN').ok).toBe(false);
    expect(canTransition('SUBMITTED', 'CLOSED', 'ADMIN').ok).toBe(false);
  });

  it('never leaves a complaint able to go backwards down the ladder', () => {
    expect(canTransition('RESOLVED', 'IN_PROGRESS', 'STAFF').ok).toBe(false);
    expect(canTransition('IN_PROGRESS', 'ASSIGNED', 'STAFF').ok).toBe(false);
  });
});

describe('who may drive a transition', () => {
  it('lets the system do the two automatic steps and nothing else', () => {
    expect(canTransition('SUBMITTED', 'ANALYZING', 'SYSTEM').ok).toBe(true);
    expect(canTransition('ANALYZING', 'ASSIGNED', 'SYSTEM').ok).toBe(true);
    // Resolving is a claim about the real world; no automatic path makes it.
    expect(canTransition('IN_PROGRESS', 'RESOLVED', 'SYSTEM').ok).toBe(false);
  });

  it('keeps a student out of the staff workflow', () => {
    const check = canTransition('ASSIGNED', 'ACKNOWLEDGED', 'STUDENT');
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.code).toBe('FORBIDDEN');
    expect(canTransition('IN_PROGRESS', 'RESOLVED', 'STUDENT').ok).toBe(false);
  });

  it('gives the student the two moves that are genuinely theirs', () => {
    // Layer 9 builds the screens; the rules are already here, which is why that
    // layer adds a UI rather than a new set of permissions.
    expect(canTransition('RESOLVED', 'CLOSED', 'STUDENT').ok).toBe(true);
    expect(canTransition('RESOLVED', 'REOPENED', 'STUDENT', 'the wifi is still down').ok).toBe(true);
  });

  it('reserves rejection for a manager', () => {
    expect(canTransition('IN_PROGRESS', 'REJECTED', 'STAFF', 'not a campus issue').ok).toBe(false);
    expect(canTransition('IN_PROGRESS', 'REJECTED', 'DEPT_MANAGER', 'not a campus issue').ok).toBe(true);
  });

  it('lets the waiting student answer and restart the work', () => {
    expect(canTransition('WAITING_FOR_STUDENT', 'IN_PROGRESS', 'STUDENT').ok).toBe(true);
  });
});

describe('transitions that need a reason', () => {
  it('refuses to reject or reopen silently', () => {
    const rejected = canTransition('ACKNOWLEDGED', 'REJECTED', 'ADMIN');
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.code).toBe('NOTE_REQUIRED');

    expect(canTransition('ACKNOWLEDGED', 'REJECTED', 'ADMIN', '   ').ok).toBe(false);
    expect(canTransition('ACKNOWLEDGED', 'REJECTED', 'ADMIN', 'duplicate of a works order').ok).toBe(true);
  });

  it('does not demand one for the ordinary steps', () => {
    expect(canTransition('ACKNOWLEDGED', 'IN_PROGRESS', 'STAFF').ok).toBe(true);
    expect(canTransition('IN_PROGRESS', 'RESOLVED', 'STAFF').ok).toBe(true);
  });
});

describe('nextStatuses — what the staff panel renders', () => {
  it('offers exactly the legal moves, and no more', () => {
    const staff = nextStatuses('ASSIGNED', 'STAFF').map((r) => r.to);
    expect(staff).toContain('ACKNOWLEDGED');
    expect(staff).toContain('DUPLICATE');
    // Only a manager rejects, so the button is not even drawn for staff.
    expect(staff).not.toContain('REJECTED');
    expect(nextStatuses('ASSIGNED', 'DEPT_MANAGER').map((r) => r.to)).toContain('REJECTED');
  });

  it('has nothing to offer on a duplicate', () => {
    expect(nextStatuses('DUPLICATE', 'ADMIN')).toHaveLength(0);
  });

  it('lets a closed complaint be reopened but not re-resolved', () => {
    const moves = nextStatuses('CLOSED', 'STAFF').map((r) => r.to);
    expect(moves).toEqual(['REOPENED']);
  });
});

describe('pathTo — the incident-wide action (§17)', () => {
  it('walks an untouched complaint all the way to resolved', () => {
    // Forty complaints sit at ASSIGNED when one fix lands. "Resolve all" has to
    // reach them without the table growing a shortcut edge.
    const path = pathTo('ASSIGNED', 'RESOLVED', 'STAFF');
    expect(path?.map((r) => r.to)).toEqual(['ACKNOWLEDGED', 'RESOLVED']);
  });

  it('is empty for a complaint already where it is going', () => {
    expect(pathTo('RESOLVED', 'RESOLVED', 'STAFF')).toEqual([]);
  });

  it('refuses to route through a step that needs a reason', () => {
    // Reaching IN_PROGRESS from RESOLVED would mean passing through a reopen,
    // and nobody reopened anything — so there is no path at all.
    expect(pathTo('RESOLVED', 'IN_PROGRESS', 'STAFF')).toBeNull();
  });

  it('still allows the destination itself to need one', () => {
    const path = pathTo('ASSIGNED', 'REJECTED', 'ADMIN');
    expect(path?.at(-1)?.to).toBe('REJECTED');
  });

  it('finds nothing for an actor who may not make the move', () => {
    expect(pathTo('ASSIGNED', 'RESOLVED', 'STUDENT')).toBeNull();
    expect(pathTo('DUPLICATE', 'RESOLVED', 'ADMIN')).toBeNull();
  });
});

describe('the table itself', () => {
  it('has no duplicate edges — one from/to pair, one rule', () => {
    const seen = new Set<string>();
    for (const rule of TRANSITIONS) {
      const key = `${rule.from}→${rule.to}`;
      expect(seen.has(key), `duplicate rule ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it('names every state, so nothing renders as a raw enum', () => {
    for (const rule of TRANSITIONS) {
      expect(STATUS_LABEL[rule.from]).toBeTruthy();
      expect(STATUS_LABEL[rule.to]).toBeTruthy();
      expect(rule.narration.length).toBeGreaterThan(0);
    }
  });

  it('agrees with the settled/active helpers the incident rollup relies on', () => {
    expect(isSettled('RESOLVED')).toBe(true);
    expect(isSettled('CLOSED')).toBe(true);
    expect(isSettled('DUPLICATE')).toBe(true);
    expect(isSettled('IN_PROGRESS')).toBe(false);

    expect(isActive('IN_PROGRESS')).toBe(true);
    expect(isActive('WAITING_FOR_STUDENT')).toBe(true);
    expect(isActive('ASSIGNED')).toBe(false);
  });
});
