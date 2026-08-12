import { describe, expect, it } from 'vitest';
import {
  detectRecurring,
  growthAcross,
  trailingRise,
  type TrendSeries,
} from '@/lib/analytics/recurring';

const MONTHS = [
  new Date(Date.UTC(2026, 0, 1)),
  new Date(Date.UTC(2026, 1, 1)),
  new Date(Date.UTC(2026, 2, 1)),
  new Date(Date.UTC(2026, 3, 1)),
];

function series(counts: number[], over: Partial<TrendSeries> = {}): TrendSeries {
  return {
    categoryKey: 'NETWORK',
    categoryLabel: 'WiFi / Network',
    locationId: 'loc-cse',
    locationName: 'CSE Block',
    months: counts.map((count, i) => ({ month: MONTHS[i], count })),
    ...over,
  };
}

describe('detectRecurring', () => {
  // §27's own example: 12 → 18 → 27 → 43 in CSE Block.
  it('fires on the spec’s escalating WiFi trend and says so in numbers', () => {
    const [signal] = detectRecurring([series([12, 18, 27, 43])]);

    expect(signal).toBeTruthy();
    expect(signal.occurrences).toBe(100);
    expect(signal.growthRate).toBeCloseTo(43 / 12 - 1, 5);
    expect(signal.risingMonths).toBe(3);
    expect(signal.severity).toBe('ACT');
    expect(signal.narrative).toContain('CSE Block');
    expect(signal.narrative).toContain('12 to 43');
    expect(signal.narrative).toContain('January to April');
    // §30 asks what to *do*, and the answer is about the infrastructure.
    expect(signal.suggestion).toMatch(/Inspect the network/);
    expect(signal.windowStart).toEqual(MONTHS[0]);
    expect(signal.windowEnd.getUTCMonth()).toBe(3);
  });

  it('says nothing about a flat or falling trend', () => {
    expect(detectRecurring([series([20, 19, 21, 20])])).toEqual([]);
    expect(detectRecurring([series([40, 30, 20, 10])])).toEqual([]);
  });

  // Growth alone flags a quiet corner going from one complaint to three, which
  // teaches an administrator to ignore the panel.
  it('ignores a steep rise in tiny numbers', () => {
    expect(detectRecurring([series([0, 1, 1, 3])])).toEqual([]);
  });

  // And volume alone flags the busiest building on campus every month forever.
  it('ignores a busy but stable location', () => {
    expect(detectRecurring([series([30, 31, 30, 32])])).toEqual([]);
  });

  it('separates a watch from something to act on', () => {
    const [watch] = detectRecurring([series([10, 10, 10, 16])]);
    expect(watch.severity).toBe('WATCH');

    const [act] = detectRecurring([series([10, 12, 16, 24])]);
    expect(act.severity).toBe('ACT');
  });

  it('ranks what needs action above what needs watching, steepest first', () => {
    const signals = detectRecurring([
      series([10, 10, 10, 16], { locationId: 'a', locationName: 'Hostel A' }),
      series([8, 12, 20, 40], { locationId: 'b', locationName: 'CSE Block' }),
      series([6, 8, 11, 15], { locationId: 'c', locationName: 'ECE Block' }),
    ]);

    expect(signals.map((s) => s.locationName)).toEqual(['CSE Block', 'ECE Block', 'Hostel A']);
    expect(signals[0].severity).toBe('ACT');
    expect(signals.at(-1)!.severity).toBe('WATCH');
  });

  it('speaks about the campus when a trend has no building', () => {
    const [signal] = detectRecurring([
      series([10, 14, 20, 30], { locationId: null, locationName: null }),
    ]);
    expect(signal.narrative).toContain('across campus');
    expect(signal.suggestion).toContain('campus-wide');
  });

  it('reads only the most recent months it is asked for', () => {
    // A four-month window ending flat, with an old spike outside it.
    const long: TrendSeries = {
      ...series([40, 5, 5, 5]),
      months: [
        { month: new Date(Date.UTC(2025, 8, 1)), count: 40 },
        { month: new Date(Date.UTC(2025, 9, 1)), count: 5 },
        { month: new Date(Date.UTC(2025, 10, 1)), count: 5 },
        { month: new Date(Date.UTC(2025, 11, 1)), count: 6 },
      ],
    };
    expect(detectRecurring([long], { months: 3 })).toEqual([]);
  });

  // The case real data hit first: every complaint in the newest month, because
  // that is when the system started. "Up 5200% since March" is arithmetic
  // pretending to be a finding.
  it('does not call the start of the data a trend', () => {
    expect(detectRecurring([series([0, 0, 0, 52])])).toEqual([]);
  });

  it('does flag a problem that begins mid-window and climbs', () => {
    const [signal] = detectRecurring([series([0, 5, 20, 40])]);
    expect(signal).toBeTruthy();
    expect(signal.hasBaseline).toBe(false);
    // No baseline means no percentage — the words say what happened instead.
    expect(signal.growthLabel).toBe('up from none');
    expect(signal.narrative).toContain('from none before');
    expect(signal.narrative).not.toContain('%');
    expect(signal.severity).toBe('ACT');
  });

  it('states a percentage only where there was something to grow from', () => {
    const [withBaseline] = detectRecurring([series([12, 18, 27, 43])]);
    expect(withBaseline.hasBaseline).toBe(true);
    expect(withBaseline.growthLabel).toBe('up 258%');
    expect(withBaseline.narrative).toContain('258%');
  });

  it('needs at least two months before it will claim a direction', () => {
    const single: TrendSeries = { ...series([50]), months: [{ month: MONTHS[0], count: 50 }] };
    expect(detectRecurring([single])).toEqual([]);
  });

  it('respects thresholds it is given', () => {
    const quiet = series([2, 2, 3, 4]);
    expect(detectRecurring([quiet])).toEqual([]);
    expect(detectRecurring([quiet], { minOccurrences: 5, minGrowth: 0.5 })).toHaveLength(1);
  });
});

describe('growthAcross', () => {
  it('measures end to end, so one flat month does not cancel a climb', () => {
    const m = (count: number, i: number) => ({ month: MONTHS[i], count });
    expect(growthAcross([m(10, 0), m(10, 1), m(20, 2), m(30, 3)])).toBe(2);
  });

  it('treats a rise from nothing as one increase per month rather than dividing by zero', () => {
    const m = (count: number, i: number) => ({ month: MONTHS[i], count });
    expect(growthAcross([m(0, 0), m(4, 1)])).toBe(4);
    expect(Number.isFinite(growthAcross([m(0, 0), m(9, 1)]))).toBe(true);
    expect(growthAcross([m(0, 0), m(0, 1)])).toBe(0);
  });
});

describe('trailingRise', () => {
  it('counts only the consecutive rises that end the window', () => {
    const m = (count: number, i: number) => ({ month: MONTHS[i], count });
    expect(trailingRise([m(12, 0), m(18, 1), m(27, 2), m(43, 3)])).toBe(3);
    expect(trailingRise([m(50, 0), m(10, 1), m(11, 2), m(12, 3)])).toBe(2);
    expect(trailingRise([m(10, 0), m(20, 1), m(30, 2), m(30, 3)])).toBe(0);
  });
});
