import { describe, expect, it } from 'vitest';
import { LADDER, stepperFor } from '@/lib/lifecycle/stepper';
import { statusStamps, timelineEntry } from '@/lib/lifecycle/timeline';
import type { ComplaintStatus } from '@/generated/prisma/enums';

const AT = new Date('2026-08-13T10:20:00Z');
const min = (n: number) => new Date(AT.getTime() + n * 60_000);

const stamps: Partial<Record<ComplaintStatus, Date>> = {
  ANALYZING: min(0),
  ASSIGNED: min(1),
  ACKNOWLEDGED: min(25),
  IN_PROGRESS: min(55),
};

const state = (steps: ReturnType<typeof stepperFor>, key: string) =>
  steps.find((s) => s.key === key)?.state;

describe('§20 stepper', () => {
  it('reproduces the spec example', () => {
    // ✓ Submitted ✓ Analyzed ✓ Assigned to IT ✓ Acknowledged ● In Progress
    // ○ Resolved ○ Closed
    const steps = stepperFor({
      status: 'IN_PROGRESS',
      stamps,
      departmentName: 'IT',
      submittedAt: AT,
    });

    expect(steps.map((s) => s.state)).toEqual([
      'DONE',
      'DONE',
      'DONE',
      'DONE',
      'CURRENT',
      'PENDING',
      'PENDING',
    ]);
    expect(steps.find((s) => s.key === 'ASSIGNED')?.label).toBe('Assigned to IT');
  });

  it('times every step it has ticked, and none it has not', () => {
    const steps = stepperFor({ status: 'IN_PROGRESS', stamps, departmentName: 'IT', submittedAt: AT });
    for (const step of steps) {
      if (step.state === 'PENDING') expect(step.at).toBeNull();
      else expect(step.at).toBeInstanceOf(Date);
    }
    // The first step is the complaint's own creation, with no event behind it.
    expect(steps[0].at).toEqual(AT);
  });

  it('keeps the progress a waiting complaint has already made', () => {
    const steps = stepperFor({
      status: 'WAITING_FOR_STUDENT',
      stamps,
      departmentName: 'IT',
      submittedAt: AT,
    });
    expect(state(steps, 'ACKNOWLEDGED')).toBe('DONE');
    expect(state(steps, 'IN_PROGRESS')).toBe('CURRENT');
    expect(steps.find((s) => s.key === 'IN_PROGRESS')?.note).toBe('Waiting for your reply');
  });

  it('un-ticks resolution when a complaint is reopened', () => {
    // The old RESOLVED stamp is still on the timeline and must not read as a
    // tick — the issue is not fixed, which is the entire point of a reopen.
    const steps = stepperFor({
      status: 'REOPENED',
      stamps: { ...stamps, RESOLVED: min(120) },
      departmentName: 'IT',
      submittedAt: AT,
    });
    expect(state(steps, 'ASSIGNED')).toBe('CURRENT');
    expect(state(steps, 'RESOLVED')).toBe('PENDING');
    expect(steps.find((s) => s.key === 'RESOLVED')?.at).toBeNull();
  });

  it('stops the ladder where a rejected complaint stopped', () => {
    const steps = stepperFor({
      status: 'REJECTED',
      stamps: { ANALYZING: min(0), ASSIGNED: min(1), REJECTED: min(30) },
      departmentName: 'IT',
      submittedAt: AT,
    });
    // No dangling "○ Resolved": nothing more is coming, and saying otherwise
    // would promise a fix that will not happen.
    expect(steps.map((s) => s.key)).toEqual(['SUBMITTED', 'ANALYZING', 'ASSIGNED', 'REJECTED']);
    expect(steps.at(-1)?.state).toBe('CURRENT');
  });

  it('shows a brand-new complaint at the first rung', () => {
    const steps = stepperFor({ status: 'SUBMITTED', stamps: {}, submittedAt: AT });
    expect(steps).toHaveLength(LADDER.length);
    expect(steps[0].state).toBe('CURRENT');
    expect(steps.slice(1).every((s) => s.state === 'PENDING')).toBe(true);
  });
});

describe('the update feed', () => {
  const event = (over: Partial<Parameters<typeof timelineEntry>[0]> = {}) => ({
    id: 'e1',
    type: 'STATUS_CHANGED' as const,
    message: null,
    meta: {},
    isInternal: false,
    createdAt: AT,
    actorName: null,
    ...over,
  });

  it('says what happened, not which enum was written', () => {
    const entry = timelineEntry(
      event({ meta: { to: 'IN_PROGRESS', narration: 'Investigation started' } }),
    );
    expect(entry.headline).toBe('Investigation started');
  });

  it('names the department on assignment, as §20 does', () => {
    const entry = timelineEntry(
      event({ meta: { to: 'ASSIGNED', narration: 'Assigned to a department', departmentName: 'IT' } }),
    );
    expect(entry.headline).toBe('Assigned to IT');
  });

  it('says when a move came from the wider incident', () => {
    const entry = timelineEntry(
      event({ meta: { to: 'RESOLVED', narration: 'Marked resolved', viaIncident: 'INC-004' } }),
    );
    expect(entry.headline).toBe('Marked resolved (with INC-004)');
  });

  it('names the person behind a human update', () => {
    const entry = timelineEntry(
      event({ type: 'PROGRESS_UPDATE', message: 'Switch replaced', actorName: 'Priya' }),
    );
    expect(entry.headline).toBe('Progress update · Priya');
    expect(entry.detail).toBe('Switch replaced');
  });

  it('takes the first entry into a status, so a reopen does not rewrite history', () => {
    const stampsFromFeed = statusStamps([
      event({ id: 'a', meta: { to: 'IN_PROGRESS' }, createdAt: min(10) }),
      event({ id: 'b', meta: { to: 'RESOLVED' }, createdAt: min(20) }),
      event({ id: 'c', meta: { to: 'REOPENED' }, createdAt: min(30) }),
      event({ id: 'd', meta: { to: 'IN_PROGRESS' }, createdAt: min(40) }),
    ]);
    expect(stampsFromFeed.IN_PROGRESS).toEqual(min(10));
  });
});
