import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireApiRole } from '@/lib/auth/api';
import { loadForAction } from '@/lib/complaints/access';
import { confirmResolution } from '@/lib/feedback/service';

/**
 * §23 — the student's answer to "was the issue actually fixed?".
 *
 * Every rule lives in `feedback/service.ts`; this handler decides only who is
 * allowed to see the complaint at all (`loadForAction` gives a stranger a 404
 * rather than telling them it exists) and which HTTP status each refusal is.
 */
const ConfirmBody = z.discriminatedUnion('confirmed', [
  z.object({ confirmed: z.literal(true) }),
  /** "Still having the problem" is unactionable without what is still wrong. */
  z.object({ confirmed: z.literal(false), reason: z.string().trim().min(1).max(2000) }),
]);

export async function POST(request: Request, { params }: RouteContext<'/api/complaints/[id]/confirm'>) {
  const session = await requireApiRole();
  if (session instanceof NextResponse) return session;

  const parsed = ConfirmBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'confirmed must be true, or false with a reason the department can act on' },
      { status: 400 },
    );
  }

  const { id } = await params;
  const found = await loadForAction(id, session);
  if ('error' in found) return found.error;

  const outcome = await confirmResolution({
    complaintId: found.complaint.id,
    actor: { id: session.sub, role: session.role },
    confirmed: parsed.data.confirmed,
    reason: parsed.data.confirmed ? null : parsed.data.reason,
  });

  if (!outcome.ok) {
    const status =
      outcome.code === 'NOT_FOUND'
        ? 404
        : outcome.code === 'NOT_YOURS'
          ? 403
          : outcome.code === 'NO_REASON'
            ? 400
            : 409;
    return NextResponse.json({ error: outcome.reason, status: outcome.status }, { status });
  }

  return NextResponse.json({
    complaint: { id: found.complaint.id, code: found.complaint.code, status: outcome.status },
    narration: outcome.narration,
    ratingRequested: outcome.ratingRequested,
  });
}
