import { describe, expect, it } from 'vitest';
import { queueBucket, slaRisk, sortQueue, type QueueRow } from '@/lib/queue/rank';

const NOW = new Date('2026-08-13T12:00:00Z');
const hours = (n: number) => new Date(NOW.getTime() + n * 3_600_000);

const row = (over: Partial<QueueRow> = {}): QueueRow => ({
  priority: 'MEDIUM',
  priorityScore: 40,
  status: 'ASSIGNED',
  createdAt: hours(-4),
  responseDueAt: null,
  resolutionDueAt: null,
  respondedAt: null,
  ...over,
});

describe('§21 ordering', () => {
  it('puts critical first, then high, then at-risk, then normal', () => {
    const critical = row({ priority: 'CRITICAL' });
    const high = row({ priority: 'HIGH' });
    const atRisk = row({ resolutionDueAt: hours(0.5), respondedAt: hours(-3) });
    const normal = row();

    const sorted = sortQueue([normal, atRisk, high, critical], NOW);
    expect(sorted).toEqual([critical, high, atRisk, normal]);
  });

  it('sinks finished work below everything still needing attention', () => {
    const done = row({ priority: 'CRITICAL', status: 'RESOLVED' });
    const open = row({ priority: 'LOW' });
    expect(sortQueue([done, open], NOW)).toEqual([open, done]);
    expect(queueBucket(done, NOW)).toBe('DONE');
  });

  it('breaks ties by score and then by age, so nothing starves', () => {
    const older = row({ priority: 'HIGH', priorityScore: 50, createdAt: hours(-9) });
    const newer = row({ priority: 'HIGH', priorityScore: 50, createdAt: hours(-1) });
    const higherScore = row({ priority: 'HIGH', priorityScore: 70, createdAt: hours(-1) });

    expect(sortQueue([newer, older, higherScore], NOW)).toEqual([higherScore, older, newer]);
  });

  it('puts a breach ahead of a mere risk inside the same bucket', () => {
    const breached = row({ resolutionDueAt: hours(-1), respondedAt: hours(-3) });
    const approaching = row({ resolutionDueAt: hours(0.5), respondedAt: hours(-3) });
    expect(sortQueue([approaching, breached], NOW)).toEqual([breached, approaching]);
  });
});

describe('SLA risk', () => {
  it('reads the response clock until someone responds, then the resolution one', () => {
    const unanswered = row({ responseDueAt: hours(-1), resolutionDueAt: hours(20) });
    expect(slaRisk(unanswered, NOW)).toBe('BREACHED');

    const answered = { ...unanswered, respondedAt: hours(-2) };
    expect(slaRisk(answered, NOW)).toBe('OK');
  });

  it('calls the last quarter of a window "approaching"', () => {
    // Opened 4h ago against a 5h window: 1h left of 5 is 20%, inside the quarter.
    const approaching = row({ createdAt: hours(-4), resolutionDueAt: hours(1), respondedAt: hours(-3) });
    expect(slaRisk(approaching, NOW)).toBe('AT_RISK');

    // 3h left of a 7h window is 43% — still plenty of time.
    const fine = row({ createdAt: hours(-4), resolutionDueAt: hours(3), respondedAt: hours(-3) });
    expect(slaRisk(fine, NOW)).toBe('OK');
  });

  it('says nothing about a complaint no clock has been set on', () => {
    // Layer 8 sets the due dates. Until then the bucket must not fire, and the
    // ordering has to degrade to band → score → age rather than to noise.
    expect(slaRisk(row(), NOW)).toBe('NONE');
    expect(queueBucket(row(), NOW)).toBe('NORMAL');
    expect(queueBucket(row({ priority: 'HIGH' }), NOW)).toBe('HIGH');
  });

  it('stops the clock once the work is settled', () => {
    expect(slaRisk(row({ status: 'RESOLVED', resolutionDueAt: hours(-5) }), NOW)).toBe('NONE');
  });
});
