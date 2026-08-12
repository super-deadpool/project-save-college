import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireApiRole } from '@/lib/auth/api';
import { loadForAction } from '@/lib/complaints/access';
import { recordFeedback } from '@/lib/feedback/service';
import { MAX_RATING, MIN_RATING } from '@/lib/feedback/satisfaction';

/**
 * §24 — "how satisfied are you with the resolution?", one to five stars plus an
 * optional sentence. The measure the system is finally judged by: §31 reports it
 * and §34's health score reads it, which is what makes closing a complaint
 * quickly different from handling it well.
 *
 * The rules are in `feedback/service.ts`; this is the HTTP shape over them.
 */
const FeedbackBody = z.object({
  rating: z.number().int().min(MIN_RATING).max(MAX_RATING),
  comment: z.string().trim().max(2000).optional(),
});

export async function POST(request: Request, { params }: RouteContext<'/api/complaints/[id]/feedback'>) {
  const session = await requireApiRole();
  if (session instanceof NextResponse) return session;

  const parsed = FeedbackBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: `rating must be ${MIN_RATING}–${MAX_RATING}` }, { status: 400 });
  }

  const { id } = await params;
  const found = await loadForAction(id, session);
  if ('error' in found) return found.error;

  const outcome = await recordFeedback({
    complaintId: found.complaint.id,
    actor: { id: session.sub },
    rating: parsed.data.rating,
    comment: parsed.data.comment,
  });

  if (!outcome.ok) {
    const status =
      outcome.code === 'NOT_FOUND'
        ? 404
        : outcome.code === 'NOT_YOURS'
          ? 403
          : outcome.code === 'BAD_RATING'
            ? 400
            : 409;
    return NextResponse.json(
      { error: outcome.reason, status: outcome.status, rating: outcome.rating },
      { status },
    );
  }

  return NextResponse.json({ feedback: outcome.feedback });
}
