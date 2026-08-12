/**
 * §24's half of "was this actually fixed": the rating, and what a set of ratings
 * adds up to.
 *
 * Pure (CLAUDE.md §5) — the route validates with this, the dashboards score with
 * it, and the campus health term in §34 is derived from `satisfactionOf()` so the
 * number on the dashboard and the number in the formula cannot drift apart.
 */

export const MIN_RATING = 1;
export const MAX_RATING = 5;

export function isValidRating(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_RATING && value <= MAX_RATING;
}

/** §24's five prompts. The wording is what the student is agreeing to. */
export const RATING_LABEL: Record<number, string> = {
  1: 'Not fixed at all',
  2: 'Poorly handled',
  3: 'Fixed, eventually',
  4: 'Handled well',
  5: 'Handled excellently',
};

export interface Satisfaction {
  /** Mean rating, or null when nobody has rated anything — never a misleading 0. */
  average: number | null;
  count: number;
  /** How many of each star, 1..5, for the distribution bar. */
  histogram: Record<number, number>;
  /** The share of ratings at 4 or 5 — the number §31 calls "student satisfaction". */
  positiveRate: number | null;
}

export function satisfactionOf(ratings: number[]): Satisfaction {
  const valid = ratings.filter(isValidRating);
  const histogram: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const rating of valid) histogram[rating] += 1;

  if (valid.length === 0) {
    return { average: null, count: 0, histogram, positiveRate: null };
  }

  const total = valid.reduce((sum, r) => sum + r, 0);
  const positive = valid.filter((r) => r >= 4).length;

  return {
    average: total / valid.length,
    count: valid.length,
    histogram,
    positiveRate: positive / valid.length,
  };
}

/**
 * Satisfaction as a 0..1 fraction, which is the shape §34's health score wants.
 * An unrated campus contributes nothing rather than a zero: no feedback is not
 * the same as bad feedback, and treating it as bad would punish a quiet week.
 */
export function satisfactionFraction(average: number | null): number | null {
  if (average == null) return null;
  return (average - MIN_RATING) / (MAX_RATING - MIN_RATING);
}
