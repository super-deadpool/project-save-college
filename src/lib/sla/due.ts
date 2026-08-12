import type { Priority } from '@/generated/prisma/enums';

/**
 * §22's promise, as arithmetic: a band and a starting instant become the two
 * moments this complaint is expected to be answered by and fixed by.
 *
 * Pure (CLAUDE.md §5) — a profile, a band and a clock in, two dates out. The
 * department's `SlaProfile` row is loaded by `sla/service.ts`; nothing here
 * touches Prisma, which is what lets every window and boundary be a unit test.
 */

/** The shape of `SlaProfile` this module needs — minutes, per band. */
export interface SlaProfileLike {
  responseCritical: number;
  resolutionCritical: number;
  responseHigh: number;
  resolutionHigh: number;
  responseMedium: number;
  resolutionMedium: number;
  responseLow: number;
  resolutionLow: number;
}

/**
 * The fallback for a department with no profile attached. Same numbers as the
 * `SlaProfile` column defaults, so an unconfigured department still makes a
 * promise rather than silently making none — a complaint with no due dates can
 * never breach, and would sit in the queue forever without anyone noticing.
 */
export const DEFAULT_SLA: SlaProfileLike = {
  responseCritical: 15,
  resolutionCritical: 240,
  responseHigh: 60,
  resolutionHigh: 1440,
  responseMedium: 240,
  resolutionMedium: 4320,
  responseLow: 1440,
  resolutionLow: 10080,
};

export interface SlaWindow {
  responseMinutes: number;
  resolutionMinutes: number;
}

export function windowFor(profile: SlaProfileLike | null | undefined, band: Priority): SlaWindow {
  const p = profile ?? DEFAULT_SLA;
  switch (band) {
    case 'CRITICAL':
      return { responseMinutes: p.responseCritical, resolutionMinutes: p.resolutionCritical };
    case 'HIGH':
      return { responseMinutes: p.responseHigh, resolutionMinutes: p.resolutionHigh };
    case 'MEDIUM':
      return { responseMinutes: p.responseMedium, resolutionMinutes: p.resolutionMedium };
    case 'LOW':
      return { responseMinutes: p.responseLow, resolutionMinutes: p.resolutionLow };
  }
}

export interface SlaDueDates {
  responseDueAt: Date;
  resolutionDueAt: Date;
}

/**
 * Both clocks start at the same instant — the moment the complaint reaches a
 * department (§22: "each priority level can have a target response and
 * resolution time"). The resolution window is measured from that same start
 * rather than from the response deadline, so a fast acknowledgement buys the
 * department no extra repair time and a slow one costs it none.
 */
export function dueDatesFrom(
  start: Date,
  profile: SlaProfileLike | null | undefined,
  band: Priority,
): SlaDueDates {
  const { responseMinutes, resolutionMinutes } = windowFor(profile, band);
  return {
    responseDueAt: addMinutes(start, responseMinutes),
    resolutionDueAt: addMinutes(start, resolutionMinutes),
  };
}

export function addMinutes(at: Date, minutes: number): Date {
  return new Date(at.getTime() + minutes * 60_000);
}

/**
 * A window in words, for the staff panel and the escalation messages: "45 min",
 * "4 h", "3 d". Round numbers only — the point is "you have about a day", and a
 * precise "1439 minutes" reads like a countdown nobody is running.
 */
export function describeMinutes(minutes: number): string {
  const abs = Math.abs(Math.round(minutes));
  if (abs < 60) return `${abs} min`;
  if (abs < 60 * 24) {
    const hours = abs / 60;
    return `${trim(hours)} h`;
  }
  return `${trim(abs / (60 * 24))} d`;
}

function trim(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** Signed minutes from `from` to `to` — negative when `to` is in the past. */
export function minutesBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 60_000;
}
