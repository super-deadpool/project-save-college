import { describe, expect, it } from 'vitest';
import {
  isValidRating,
  RATING_LABEL,
  satisfactionFraction,
  satisfactionOf,
} from '@/lib/feedback/satisfaction';

describe('isValidRating', () => {
  it('accepts only the five stars §24 offers', () => {
    expect([1, 2, 3, 4, 5].every(isValidRating)).toBe(true);
    for (const bad of [0, 6, 2.5, -1, '4', null, undefined, NaN]) {
      expect(isValidRating(bad)).toBe(false);
    }
  });

  it('has a label for every star, so a rating is never shown as a bare number', () => {
    for (const star of [1, 2, 3, 4, 5]) expect(RATING_LABEL[star]).toBeTruthy();
  });
});

describe('satisfactionOf', () => {
  it('averages, counts and distributes', () => {
    const result = satisfactionOf([5, 4, 4, 2]);
    expect(result.count).toBe(4);
    expect(result.average).toBe(3.75);
    expect(result.histogram).toEqual({ 1: 0, 2: 1, 3: 0, 4: 2, 5: 1 });
    expect(result.positiveRate).toBe(0.75);
  });

  // No feedback is not bad feedback. A zero here would put an unrated week at the
  // bottom of every department comparison it appears in.
  it('reports null rather than zero when nobody has rated anything', () => {
    const empty = satisfactionOf([]);
    expect(empty).toMatchObject({ average: null, count: 0, positiveRate: null });
    expect(empty.histogram).toEqual({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 });
  });

  it('ignores values that are not ratings rather than averaging them in', () => {
    const result = satisfactionOf([5, 0, 9, 3] as number[]);
    expect(result.count).toBe(2);
    expect(result.average).toBe(4);
  });
});

describe('satisfactionFraction', () => {
  it('maps the five stars onto 0..1 for §34s formula', () => {
    expect(satisfactionFraction(1)).toBe(0);
    expect(satisfactionFraction(3)).toBe(0.5);
    expect(satisfactionFraction(5)).toBe(1);
  });

  it('stays null when there is nothing to map', () => {
    expect(satisfactionFraction(null)).toBeNull();
  });
});
