import type { IncidentStatus, Priority } from '@/generated/prisma/enums';

/**
 * Smart incident communication, spec §36. When many students report one thing,
 * telling each of them "your complaint is being processed" is the wrong answer —
 * they already know something is wrong, and the useful information is that it is
 * *known*, *shared*, and *being worked on*.
 *
 * Pure: facts in, sentences out. This is prose the system is *certain* about, so
 * it is templated rather than generated — §36's message is a status report, not
 * a narrative, and it must read identically with no API key.
 */

export const INCIDENT_STATUS_LABEL: Record<IncidentStatus, string> = {
  OPEN: 'Open',
  IN_PROGRESS: 'In progress',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
};

export interface IncidentFacts {
  code: string;
  title: string;
  status: IncidentStatus;
  priority: Priority;
  affectedCount: number;
  departmentName: string | null;
}

export interface IncidentMessage {
  heading: string;
  /** The situation, in one sentence. */
  body: string;
  statusLabel: string;
  /** §18 — the count, phrased for a student rather than a dashboard. */
  affectedLine: string;
  /** §36's whole point: stop the fifth duplicate before it is written. */
  reassurance: string;
}

/**
 * Only shown when an incident actually has more than one reporter — a size-1
 * incident is just a complaint (plan.MD §6) and telling a student their solitary
 * report "affects multiple students" would be a lie the system can't take back.
 */
export function isSharedIncident(affectedCount: number): boolean {
  return affectedCount > 1;
}

export function incidentMessage(facts: IncidentFacts): IncidentMessage {
  const others = facts.affectedCount - 1;
  const owner = facts.departmentName ?? 'The campus office';

  return {
    heading: facts.title,
    body:
      facts.status === 'RESOLVED' || facts.status === 'CLOSED'
        ? `${owner} has resolved this issue. If you are still affected, you can reopen your complaint.`
        : `We have identified an issue affecting multiple students. ${owner} is currently working on it.`,
    statusLabel: INCIDENT_STATUS_LABEL[facts.status],
    affectedLine:
      others <= 0
        ? 'You are the first to report this.'
        : others === 1
          ? '1 other student has reported this issue.'
          : `${others} other students have reported this issue.`,
    reassurance: "You don't need to submit another complaint — you'll be updated here.",
  };
}
