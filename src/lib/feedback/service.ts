import { prisma } from '@/lib/db';
import { recordEvent, transition } from '@/lib/lifecycle/transition';
import { isValidRating, MAX_RATING, MIN_RATING, RATING_LABEL } from './satisfaction';
import type { ComplaintStatus, Role } from '@/generated/prisma/enums';

/**
 * §23 and §24 as one service: the student's verdict on a resolution, and their
 * rating of it.
 *
 * The two route handlers over this are thin on purpose — they turn an outcome
 * into an HTTP status and nothing else. The decisions live here so the gate can
 * drive them with no API and no LLM, which is the same reason `createComplaint`
 * and `applyIncidentStatus` are services rather than handler bodies.
 */

export type ResolutionOutcome =
  | { ok: true; status: ComplaintStatus; narration: string; ratingRequested: boolean }
  | {
      ok: false;
      code: 'NOT_FOUND' | 'NOT_YOURS' | 'NOT_RESOLVED' | 'NO_REASON' | 'ILLEGAL';
      reason: string;
      status?: ComplaintStatus;
    };

export interface ConfirmInput {
  complaintId: string;
  actor: { id: string; role: Role };
  confirmed: boolean;
  /** Required when declining: "still broken" is unactionable on its own. */
  reason?: string | null;
}

/**
 * §23 — "was the issue actually fixed?"
 *
 * `[Yes]` closes the complaint. `[No]` sends it back with the student's sentence,
 * which re-flags the department and, through `transition()`, tears up the SLA
 * promise of the attempt that failed and starts a fresh one.
 */
export async function confirmResolution(input: ConfirmInput): Promise<ResolutionOutcome> {
  const complaint = await prisma.complaint.findUnique({
    where: { id: input.complaintId },
    select: { id: true, status: true, reporterId: true },
  });
  if (!complaint) return { ok: false, code: 'NOT_FOUND', reason: 'Complaint not found' };

  // The question belongs to the person it happened to. Staff — and an admin —
  // answering it on their behalf is the "it disappeared" this layer prevents.
  if (complaint.reporterId !== input.actor.id) {
    return { ok: false, code: 'NOT_YOURS', reason: 'Only the person who reported this can answer' };
  }
  if (complaint.status !== 'RESOLVED') {
    return {
      ok: false,
      code: 'NOT_RESOLVED',
      reason: 'There is no resolution to confirm yet',
      status: complaint.status,
    };
  }

  if (input.confirmed) {
    // The confirmation is its own event: "closed" alone does not record that a
    // human checked, and §31's confirmed-versus-reopened split needs both halves.
    await recordEvent({
      complaintId: complaint.id,
      type: 'RESOLUTION_CONFIRMED',
      actorId: input.actor.id,
      message: 'The student confirmed the issue was fixed.',
    });
    const outcome = await transition({
      complaintId: complaint.id,
      to: 'CLOSED',
      actor: { id: input.actor.id, role: input.actor.role },
      meta: { confirmedByReporter: true },
    });
    if (!outcome.ok) return { ok: false, code: 'ILLEGAL', reason: outcome.reason };

    // §24 follows §23 immediately — the caller asks for the stars next.
    return { ok: true, status: outcome.to, narration: outcome.narration, ratingRequested: true };
  }

  const reason = input.reason?.trim();
  if (!reason) {
    return { ok: false, code: 'NO_REASON', reason: 'Say what is still wrong so the department can act on it' };
  }

  await recordEvent({
    complaintId: complaint.id,
    type: 'RESOLUTION_REJECTED',
    actorId: input.actor.id,
    message: reason,
  });
  const outcome = await transition({
    complaintId: complaint.id,
    to: 'REOPENED',
    actor: { id: input.actor.id, role: input.actor.role },
    note: reason,
    meta: { rejectedByReporter: true },
  });
  if (!outcome.ok) return { ok: false, code: 'ILLEGAL', reason: outcome.reason };

  return { ok: true, status: outcome.to, narration: outcome.narration, ratingRequested: false };
}

export type FeedbackOutcome =
  | {
      ok: true;
      feedback: { rating: number; comment: string | null; label: string; resolutionConfirmed: boolean };
    }
  | {
      ok: false;
      code: 'NOT_FOUND' | 'NOT_YOURS' | 'NOT_FINISHED' | 'ALREADY_RATED' | 'BAD_RATING';
      reason: string;
      status?: ComplaintStatus;
      rating?: number;
    };

export interface FeedbackInput {
  complaintId: string;
  actor: { id: string };
  rating: number;
  comment?: string | null;
}

/**
 * §24 — one to five stars and an optional sentence. It never moves the complaint:
 * a rating is an opinion about what happened, not a step in the lifecycle.
 *
 * One rating per complaint. A second one would leave the campus average
 * depending on how many times a student pressed the button.
 */
export async function recordFeedback(input: FeedbackInput): Promise<FeedbackOutcome> {
  if (!isValidRating(input.rating)) {
    return { ok: false, code: 'BAD_RATING', reason: `rating must be ${MIN_RATING}–${MAX_RATING}` };
  }

  const complaint = await prisma.complaint.findUnique({
    where: { id: input.complaintId },
    select: { id: true, status: true, reporterId: true },
  });
  if (!complaint) return { ok: false, code: 'NOT_FOUND', reason: 'Complaint not found' };

  if (complaint.reporterId !== input.actor.id) {
    return { ok: false, code: 'NOT_YOURS', reason: 'Only the person who reported this can rate it' };
  }

  // There has to be a resolution to have an opinion about. A complaint the
  // student has just sent back is not finished being handled, and rating it now
  // would score an attempt that is still running.
  if (complaint.status !== 'RESOLVED' && complaint.status !== 'CLOSED') {
    return {
      ok: false,
      code: 'NOT_FINISHED',
      reason: 'You can rate the resolution once the work is done',
      status: complaint.status,
    };
  }

  const existing = await prisma.feedback.findUnique({ where: { complaintId: complaint.id } });
  if (existing) {
    return {
      ok: false,
      code: 'ALREADY_RATED',
      reason: 'You have already rated this complaint',
      rating: existing.rating,
    };
  }

  const comment = input.comment?.trim() || null;
  const feedback = await prisma.feedback.create({
    data: {
      complaintId: complaint.id,
      userId: input.actor.id,
      rating: input.rating,
      comment,
      // A rating on a CLOSED complaint follows the student's own "yes, it was
      // fixed" (§23). One left on a RESOLVED complaint they never confirmed is a
      // rating of the work, not a confirmation of it.
      resolutionConfirmed: complaint.status === 'CLOSED',
    },
  });

  await recordEvent({
    complaintId: complaint.id,
    type: 'FEEDBACK_SUBMITTED',
    actorId: input.actor.id,
    message: comment ?? RATING_LABEL[input.rating],
    // The feed puts the number in the headline (`lifecycle/timeline.ts`).
    meta: { rating: input.rating, resolutionConfirmed: feedback.resolutionConfirmed },
  });

  return {
    ok: true,
    feedback: {
      rating: feedback.rating,
      comment: feedback.comment,
      label: RATING_LABEL[feedback.rating],
      resolutionConfirmed: feedback.resolutionConfirmed,
    },
  };
}
