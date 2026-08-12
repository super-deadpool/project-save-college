/**
 * How the dashboards say a number out loud.
 *
 * Pure, and shared by the pages and the API so a figure reads identically in
 * both: "—" where there is no data, never a misleading 0%; hours as hours until
 * they are days; percentages rounded, because a compliance figure of 87.3% is
 * three digits of false precision over a hundred complaints.
 */

/** A count of something that might not exist yet. */
export function count(value: number | null | undefined): string {
  return value == null ? '—' : value.toLocaleString('en-IN');
}

/** 0..1 → "87%". Null stays null, because 0% is a claim and null is not. */
export function percent(fraction: number | null | undefined, digits = 0): string {
  if (fraction == null || !Number.isFinite(fraction)) return '—';
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** Hours as the unit a human would use: "40 min", "6.5 h", "3.2 d". */
export function duration(hours: number | null | undefined): string {
  if (hours == null || !Number.isFinite(hours)) return '—';
  // Rounding a few seconds to "0 min" reads as a bug rather than as "instantly".
  if (hours * 60 < 1) return hours <= 0 ? '0 min' : '< 1 min';
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  if (hours < 48) return `${round1(hours)} h`;
  return `${round1(hours / 24)} d`;
}

/** A §24 average, out of five. */
export function rating(average: number | null | undefined): string {
  return average == null ? '—' : `${round1(average)}/5`;
}

/** "January", "Feb" — month labels for a trend axis. */
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function monthLabel(at: Date, style: 'long' | 'short' = 'short'): string {
  const name = MONTHS_LONG[at.getUTCMonth()];
  return style === 'long' ? `${name} ${at.getUTCFullYear()}` : name.slice(0, 3);
}

export function dayLabel(at: Date): string {
  return `${at.getUTCDate()} ${MONTHS_LONG[at.getUTCMonth()].slice(0, 3)}`;
}

/** A signed term for §34's breakdown: "−8.5", "+7.5", "0". */
export function signed(points: number): string {
  const rounded = round1(points);
  if (rounded === 0) return '0';
  return rounded > 0 ? `+${rounded}` : `−${Math.abs(rounded)}`;
}

/**
 * Growth as §27 states it: "up 258%" — but only where there was a baseline to
 * grow from. A window that starts at zero has no honest percentage, so the signal
 * carries its own wording and this falls back to it.
 */
export function growth(rate: number, hasBaseline = true): string {
  return hasBaseline ? `up ${Math.round(rate * 100)}%` : 'up from none';
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
