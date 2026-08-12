import type { ComplaintStatus, EventType } from '@/generated/prisma/enums';

/**
 * §20's update feed. The spec's example is plain sentences against a clock:
 *
 *   10:21 AM  Assigned to IT Department
 *   10:45 AM  Technician acknowledged the complaint
 *
 * so this module turns a stored event into exactly that — a headline and an
 * optional detail. Pure: the caller loads the rows, this decides the words.
 */

/** The subset of `ComplaintEvent` the feed needs. Keeps this file Prisma-free. */
export interface TimelineEvent {
  id: string;
  type: EventType;
  message: string | null;
  meta: unknown;
  isInternal: boolean;
  createdAt: Date;
  actorName: string | null;
}

export interface TimelineEntry {
  id: string;
  at: Date;
  headline: string;
  detail: string | null;
  isInternal: boolean;
}

const HEADLINE: Record<EventType, string> = {
  CREATED: 'Complaint submitted',
  STATUS_CHANGED: 'Status changed',
  ASSIGNED: 'Assigned',
  COMMENT: 'Comment',
  PROGRESS_UPDATE: 'Progress update',
  INFO_REQUESTED: 'More information requested',
  INFO_PROVIDED: 'You replied',
  ESCALATED: 'Escalated',
  SLA_BREACHED: 'Response time exceeded',
  LINKED_TO_INCIDENT: 'Linked to a wider incident',
  DUPLICATE_SUGGESTED: 'Possible duplicate flagged',
  RESOLUTION_CONFIRMED: 'Resolution confirmed',
  RESOLUTION_REJECTED: 'Resolution rejected',
  FEEDBACK_SUBMITTED: 'Feedback submitted',
  ATTACHMENT_ADDED: 'Attachment added',
};

/**
 * A status change describes itself: `transition()` stores the rule's narration
 * in `meta.narration`, so the feed reads "Investigation started" rather than
 * "IN_PROGRESS". The status is the fallback for rows written before that.
 */
export function timelineEntry(event: TimelineEvent): TimelineEntry {
  const meta = (event.meta ?? {}) as {
    narration?: string;
    to?: ComplaintStatus;
    departmentName?: string;
    viaIncident?: string;
  };
  let headline = HEADLINE[event.type] ?? event.type;

  if (event.type === 'STATUS_CHANGED') {
    headline = meta.narration ?? (meta.to ? `Now ${meta.to.toLowerCase().replace(/_/g, ' ')}` : headline);
    // §20's example line is "Assigned to IT Department" — the department is the
    // informative half, so it replaces the generic narration when it is known.
    if (meta.to === 'ASSIGNED' && meta.departmentName) {
      headline = `Assigned to ${meta.departmentName}`;
    }
    if (meta.viaIncident) headline = `${headline} (with ${meta.viaIncident})`;
  }
  // "Technician acknowledged the complaint" — §20 names the person when there
  // is one. The system acts anonymously, and says so by staying silent.
  if (event.actorName && NAMES_ACTOR.has(event.type)) {
    headline = `${headline} · ${event.actorName}`;
  }

  return {
    id: event.id,
    at: event.createdAt,
    headline,
    detail: event.message?.trim() || null,
    isInternal: event.isInternal,
  };
}

const NAMES_ACTOR = new Set<EventType>(['PROGRESS_UPDATE', 'INFO_REQUESTED', 'ASSIGNED', 'COMMENT']);

/**
 * When each status was entered, read off the timeline — the stepper's input.
 * The *first* entry into a status wins: a complaint that was reopened and worked
 * again should still show when work originally started.
 */
export function statusStamps(events: TimelineEvent[]): Partial<Record<ComplaintStatus, Date>> {
  const stamps: Partial<Record<ComplaintStatus, Date>> = {};
  for (const event of events) {
    if (event.type !== 'STATUS_CHANGED') continue;
    const to = (event.meta as { to?: ComplaintStatus } | null)?.to;
    if (to && !stamps[to]) stamps[to] = event.createdAt;
  }
  return stamps;
}

/** Students never see internal staff notes (§39). */
export function visibleTo(entry: TimelineEntry, role: string): boolean {
  return !entry.isInternal || role !== 'STUDENT';
}
