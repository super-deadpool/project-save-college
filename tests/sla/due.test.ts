import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SLA,
  addMinutes,
  describeMinutes,
  dueDatesFrom,
  minutesBetween,
  windowFor,
} from '@/lib/sla/due';

const START = new Date('2026-03-01T10:00:00.000Z');

const URGENT = {
  responseCritical: 10,
  resolutionCritical: 120,
  responseHigh: 30,
  resolutionHigh: 720,
  responseMedium: 180,
  resolutionMedium: 2880,
  responseLow: 720,
  resolutionLow: 7200,
};

describe('windowFor', () => {
  it('reads the band off the profile', () => {
    expect(windowFor(URGENT, 'CRITICAL')).toEqual({ responseMinutes: 10, resolutionMinutes: 120 });
    expect(windowFor(URGENT, 'HIGH')).toEqual({ responseMinutes: 30, resolutionMinutes: 720 });
    expect(windowFor(URGENT, 'MEDIUM')).toEqual({ responseMinutes: 180, resolutionMinutes: 2880 });
    expect(windowFor(URGENT, 'LOW')).toEqual({ responseMinutes: 720, resolutionMinutes: 7200 });
  });

  // A department with no profile still has to make a promise: a complaint with
  // no due dates can never breach and would sit unnoticed forever.
  it('falls back to the standard profile when a department has none', () => {
    expect(windowFor(null, 'HIGH')).toEqual({ responseMinutes: 60, resolutionMinutes: 1440 });
    expect(windowFor(undefined, 'CRITICAL')).toEqual({
      responseMinutes: DEFAULT_SLA.responseCritical,
      resolutionMinutes: DEFAULT_SLA.resolutionCritical,
    });
  });

  it('promises sooner for a worse band, on every profile', () => {
    for (const profile of [DEFAULT_SLA, URGENT]) {
      const bands = (['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const).map((b) => windowFor(profile, b));
      for (let i = 1; i < bands.length; i++) {
        expect(bands[i].responseMinutes).toBeGreaterThan(bands[i - 1].responseMinutes);
        expect(bands[i].resolutionMinutes).toBeGreaterThan(bands[i - 1].resolutionMinutes);
      }
    }
  });
});

describe('dueDatesFrom', () => {
  it('starts both clocks at the same instant', () => {
    const { responseDueAt, resolutionDueAt } = dueDatesFrom(START, URGENT, 'HIGH');
    expect(minutesBetween(START, responseDueAt)).toBe(30);
    expect(minutesBetween(START, resolutionDueAt)).toBe(720);
  });

  // Both windows run from assignment, so acknowledging fast buys no extra
  // repair time and acknowledging slowly costs none.
  it('measures the resolution window from the start, not from the response deadline', () => {
    const { responseDueAt, resolutionDueAt } = dueDatesFrom(START, DEFAULT_SLA, 'MEDIUM');
    expect(minutesBetween(START, resolutionDueAt)).toBe(DEFAULT_SLA.resolutionMedium);
    expect(minutesBetween(responseDueAt, resolutionDueAt)).toBe(
      DEFAULT_SLA.resolutionMedium - DEFAULT_SLA.responseMedium,
    );
  });

  it('does not mutate the instant it is given', () => {
    const start = new Date(START);
    dueDatesFrom(start, URGENT, 'LOW');
    expect(start.getTime()).toBe(START.getTime());
    expect(addMinutes(START, 0).getTime()).toBe(START.getTime());
  });
});

describe('describeMinutes', () => {
  it('speaks in round units', () => {
    expect(describeMinutes(45)).toBe('45 min');
    expect(describeMinutes(60)).toBe('1 h');
    expect(describeMinutes(90)).toBe('1.5 h');
    expect(describeMinutes(1440)).toBe('1 d');
    expect(describeMinutes(4320)).toBe('3 d');
  });

  it('describes an overdue span as a magnitude', () => {
    expect(describeMinutes(-120)).toBe('2 h');
  });
});
