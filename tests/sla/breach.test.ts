import { describe, expect, it } from 'vitest';
import { escalationPlan, slaOutcome, slaState, type SlaRow } from '@/lib/sla/breach';
import { addMinutes } from '@/lib/sla/due';
import type { ComplaintStatus } from '@/generated/prisma/enums';

const CREATED = new Date('2026-03-01T10:00:00.000Z');

/** A HIGH complaint on the standard profile: 60 min to respond, 24 h to fix. */
function row(over: Partial<SlaRow> = {}): SlaRow {
  return {
    status: 'ASSIGNED',
    createdAt: CREATED,
    responseDueAt: addMinutes(CREATED, 60),
    resolutionDueAt: addMinutes(CREATED, 1440),
    respondedAt: null,
    resolvedAt: null,
    escalationLevel: 0,
    ...over,
  };
}

describe('slaState', () => {
  it('is quiet inside both windows', () => {
    const state = slaState(row(), addMinutes(CREATED, 30));
    expect(state).toMatchObject({ level: 0, worst: null, responseBreached: false });
  });

  it('breaches the response window at the deadline, not after it', () => {
    expect(slaState(row(), addMinutes(CREATED, 59)).level).toBe(0);
    expect(slaState(row(), addMinutes(CREATED, 60)).level).toBe(1);
    expect(slaState(row(), addMinutes(CREATED, 60)).worst).toBe('RESPONSE');
  });

  it('stops counting the response clock once someone answers', () => {
    const answered = row({ respondedAt: addMinutes(CREATED, 20), status: 'ACKNOWLEDGED' });
    expect(slaState(answered, addMinutes(CREATED, 600)).responseBreached).toBe(false);
    expect(slaState(answered, addMinutes(CREATED, 600)).level).toBe(0);
  });

  it('escalates to the resolution rung past the resolution deadline', () => {
    const state = slaState(row({ status: 'IN_PROGRESS', respondedAt: addMinutes(CREATED, 5) }), addMinutes(CREATED, 1441));
    expect(state).toMatchObject({ resolutionBreached: true, resolutionBreachedTwice: false, level: 2 });
  });

  it('reaches the last rung at twice the resolution window', () => {
    const worked = row({ status: 'IN_PROGRESS', respondedAt: addMinutes(CREATED, 5) });
    expect(slaState(worked, addMinutes(CREATED, 2879)).level).toBe(2);
    expect(slaState(worked, addMinutes(CREATED, 2880)).level).toBe(3);
    expect(slaState(worked, addMinutes(CREATED, 2880)).worst).toBe('RESOLUTION_2X');
  });

  // Work that is finished cannot be escalated to anybody, and re-escalating
  // yesterday's closed complaint every minute is what makes a ladder ignorable.
  it('has nothing live to breach once the complaint is settled', () => {
    const settled: ComplaintStatus[] = ['RESOLVED', 'CLOSED', 'REJECTED', 'DUPLICATE'];
    for (const status of settled) {
      const state = slaState(row({ status }), addMinutes(CREATED, 10_000));
      expect(state).toMatchObject({ level: 0, worst: null });
    }
  });

  it('never breaches a complaint with no due dates — Layer 6 rows included', () => {
    const undated = row({ responseDueAt: null, resolutionDueAt: null });
    expect(slaState(undated, addMinutes(CREATED, 100_000)).level).toBe(0);
  });

  it('counts a resolved-then-reopened complaint against its live deadline again', () => {
    // Reopening clears `resolvedAt`, so the resolution clock is running again.
    const reopened = row({ status: 'REOPENED', respondedAt: addMinutes(CREATED, 5), resolvedAt: null });
    expect(slaState(reopened, addMinutes(CREATED, 1500)).level).toBe(2);
  });
});

describe('escalationPlan', () => {
  it('walks §22 one rung at a time as the failures happen', () => {
    const late = slaState(row(), addMinutes(CREATED, 61));
    expect(escalationPlan(late, 0)).toMatchObject([{ level: 1, notify: 'DEPT_MANAGER', flagged: false }]);
  });

  it('is empty once the complaint is already on that rung — a rescan does nothing', () => {
    const late = slaState(row(), addMinutes(CREATED, 61));
    expect(escalationPlan(late, 1)).toEqual([]);
    expect(escalationPlan(late, 3)).toEqual([]);
  });

  // The failure has to have actually happened. A complaint acknowledged in two
  // minutes and then left unrepaired for a week goes straight to the admin.
  it('skips the response rung when the response was on time', () => {
    const answeredThenStalled = row({
      status: 'IN_PROGRESS',
      respondedAt: addMinutes(CREATED, 2),
    });
    const state = slaState(answeredThenStalled, addMinutes(CREATED, 1500));
    const plan = escalationPlan(state, 0);
    expect(plan.map((s) => s.level)).toEqual([2]);
    expect(plan[0].notify).toBe('ADMIN');
  });

  it('applies both remaining rungs when a scan finds a long-dead complaint', () => {
    const forgotten = slaState(row(), addMinutes(CREATED, 3000));
    const plan = escalationPlan(forgotten, 0);
    expect(plan.map((s) => s.level)).toEqual([1, 2, 3]);
    // §22's last rung is the one that flags the complaint as well as telling the admin.
    expect(plan.at(-1)).toMatchObject({ notify: 'ADMIN', flagged: true });
  });

  it('does nothing when nothing is late', () => {
    expect(escalationPlan(slaState(row(), addMinutes(CREATED, 5)), 0)).toEqual([]);
  });
});

describe('slaOutcome', () => {
  it('reads the stamps rather than the clock, so a closed complaint is still answerable', () => {
    const kept = row({
      status: 'CLOSED',
      respondedAt: addMinutes(CREATED, 30),
      resolvedAt: addMinutes(CREATED, 600),
    });
    expect(slaOutcome(kept)).toEqual({ responseMet: true, resolutionMet: true });

    const missed = row({
      status: 'CLOSED',
      respondedAt: addMinutes(CREATED, 90),
      resolvedAt: addMinutes(CREATED, 2000),
    });
    expect(slaOutcome(missed)).toEqual({ responseMet: false, resolutionMet: false });
  });

  it('says "not yet" rather than "met" when a stamp or a due date is missing', () => {
    expect(slaOutcome(row())).toEqual({ responseMet: null, resolutionMet: null });
    expect(slaOutcome(row({ responseDueAt: null, respondedAt: CREATED }))).toMatchObject({
      responseMet: null,
    });
  });
});
