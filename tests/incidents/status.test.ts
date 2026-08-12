import { describe, expect, it } from 'vitest';
import { rollupIncidentStatus } from '@/lib/incidents/status';
import type { ComplaintStatus } from '@/generated/prisma/enums';

const of = (...statuses: ComplaintStatus[]) => rollupIncidentStatus(statuses);

describe('an incident says what its members say', () => {
  it('is open while everything is still waiting to be picked up', () => {
    expect(of('ASSIGNED', 'ASSIGNED', 'ANALYZING').status).toBe('OPEN');
  });

  it('goes active as soon as one member is being worked on', () => {
    // One technician on site means the incident is being handled, even though
    // thirty-nine of the forty complaints have not been touched individually.
    expect(of('ASSIGNED', 'ASSIGNED', 'IN_PROGRESS').status).toBe('IN_PROGRESS');
    expect(of('ASSIGNED', 'ACKNOWLEDGED').status).toBe('IN_PROGRESS');
    expect(of('ASSIGNED', 'WAITING_FOR_STUDENT').status).toBe('IN_PROGRESS');
  });

  it('resolves only when every member has', () => {
    // The opposite asymmetry, and for the same reason: one fixed complaint out
    // of forty leaves thirty-nine students still without Wi-Fi.
    expect(of('RESOLVED', 'RESOLVED', 'IN_PROGRESS').status).toBe('IN_PROGRESS');
    expect(of('RESOLVED', 'RESOLVED', 'ASSIGNED').status).toBe('OPEN');
    expect(of('RESOLVED', 'RESOLVED', 'RESOLVED').status).toBe('RESOLVED');
  });

  it('counts a rejected or duplicate member as no longer waiting', () => {
    expect(of('RESOLVED', 'DUPLICATE', 'REJECTED').status).toBe('RESOLVED');
    expect(of('CLOSED', 'DUPLICATE', 'REJECTED').status).toBe('CLOSED');
  });

  it('closes only when nothing is merely resolved any more', () => {
    expect(of('CLOSED', 'RESOLVED').status).toBe('RESOLVED');
    expect(of('CLOSED', 'CLOSED').status).toBe('CLOSED');
  });

  it('reopens with the member that reopened', () => {
    expect(of('CLOSED', 'REOPENED').status).toBe('OPEN');
  });

  it('explains itself — never a bare status', () => {
    expect(of('ASSIGNED', 'IN_PROGRESS').reason).toBe('1 of 2 complaints are being worked on');
    expect(of('RESOLVED').reason).toBe('all 1 complaint is resolved');
    expect(of().status).toBe('OPEN');
  });
});
