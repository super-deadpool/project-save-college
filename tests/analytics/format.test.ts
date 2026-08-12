import { describe, expect, it } from 'vitest';
import { count, duration, growth, monthLabel, percent, rating, signed } from '@/lib/analytics/format';

describe('the dashboard’s units', () => {
  // "0%" is a claim about the campus; "—" is an admission that nobody knows yet.
  it('never turns missing data into a zero', () => {
    expect(percent(null)).toBe('—');
    expect(count(null)).toBe('—');
    expect(duration(null)).toBe('—');
    expect(rating(null)).toBe('—');
    expect(percent(Number.NaN)).toBe('—');
    expect(duration(Number.POSITIVE_INFINITY)).toBe('—');
  });

  it('picks the unit a human would use', () => {
    expect(duration(0.5)).toBe('30 min');
    expect(duration(6.5)).toBe('6.5 h');
    expect(duration(72)).toBe('3 d');
  });

  // Test complaints get resolved seconds after they are filed, and "0 min" reads
  // as a broken query rather than as "immediately".
  it('says "< 1 min" rather than rounding seconds down to nothing', () => {
    expect(duration(0.0002)).toBe('< 1 min');
    expect(duration(0)).toBe('0 min');
  });

  it('rounds percentages and states ratings out of five', () => {
    expect(percent(0.8125)).toBe('81%');
    expect(percent(0.8125, 1)).toBe('81.3%');
    expect(rating(4.75)).toBe('4.8/5');
  });

  it('signs §34s terms so a penalty cannot read as a gain', () => {
    expect(signed(-4.53)).toBe('−4.5');
    expect(signed(9.44)).toBe('+9.4');
    expect(signed(0)).toBe('0');
    expect(signed(-0.04)).toBe('0');
  });

  it('states growth only where there was a baseline', () => {
    expect(growth(2.58)).toBe('up 258%');
    expect(growth(52, false)).toBe('up from none');
  });

  it('labels months without a timezone surprise', () => {
    const march = new Date(Date.UTC(2026, 2, 1));
    expect(monthLabel(march)).toBe('Mar');
    expect(monthLabel(march, 'long')).toBe('March 2026');
  });
});
