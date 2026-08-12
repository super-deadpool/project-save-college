import type { Priority } from '@/generated/prisma/enums';

/**
 * How an incident's priority relates to its members' (plan.MD §5, spec §18).
 *
 * Two rules, both deliberate:
 *
 * 1. **An incident is at least as urgent as its worst member.** Priority never
 *    averages — one student reporting sparking inside a wider outage does not get
 *    diluted by four who reported "no power".
 * 2. **Scale escalates the incident, never the complaint.** Five students on one
 *    fault is an outage; twenty is campus-scale. But each member keeps the band
 *    the student was shown at submission (§12) — re-banding a stored complaint
 *    behind the student's back is precisely what Layer 4 was built to prevent.
 *    Staff see the escalation on the incident, which is what §18's affected count
 *    is *for*.
 *
 * Pure by design: members in, priority out.
 */

/** Ascending — the ladder escalation walks. */
export const PRIORITY_LADDER: Priority[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

/** Highest threshold first; the first one met wins. */
export const SCALE_ESCALATIONS: { affected: number; bands: number }[] = [
  { affected: 20, bands: 2 },
  { affected: 5, bands: 1 },
];

export interface IncidentPriorityResult {
  priority: Priority;
  /** The worst member band, before scale was considered. */
  memberPeak: Priority;
  bandsEscalated: number;
  /** §14's rule applied to incidents: never a band without the reason. */
  reason: string;
}

export function raiseBand(priority: Priority, bands: number): Priority {
  const index = PRIORITY_LADDER.indexOf(priority);
  if (index < 0) return priority;
  return PRIORITY_LADDER[Math.min(PRIORITY_LADDER.length - 1, index + Math.max(0, bands))];
}

export function peakPriority(members: Priority[]): Priority {
  let peak: Priority = 'LOW';
  for (const member of members) {
    if (PRIORITY_LADDER.indexOf(member) > PRIORITY_LADDER.indexOf(peak)) peak = member;
  }
  return peak;
}

export function escalationFor(affectedCount: number): number {
  return SCALE_ESCALATIONS.find((e) => affectedCount >= e.affected)?.bands ?? 0;
}

export function incidentPriority(
  memberPriorities: Priority[],
  affectedCount: number,
): IncidentPriorityResult {
  const memberPeak = peakPriority(memberPriorities);
  const bands = escalationFor(affectedCount);
  const priority = raiseBand(memberPeak, bands);

  // Escalation is capped by the ladder, so report what actually moved rather
  // than what the threshold asked for — an already-CRITICAL incident is not
  // "raised two bands" by its twentieth reporter.
  const bandsEscalated = PRIORITY_LADDER.indexOf(priority) - PRIORITY_LADDER.indexOf(memberPeak);

  const reason =
    bandsEscalated > 0
      ? `${affectedCount} students affected — raised from ${memberPeak.toLowerCase()} by scale`
      : affectedCount > 1
        ? `${affectedCount} students affected — matches the most urgent report`
        : 'matches the reported priority';

  return { priority, memberPeak, bandsEscalated, reason };
}
