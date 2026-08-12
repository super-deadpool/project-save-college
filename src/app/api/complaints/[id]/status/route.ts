import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireApiRole } from '@/lib/auth/api';
import { loadForAction } from '@/lib/complaints/access';
import { transition } from '@/lib/lifecycle/transition';
import { nextStatuses } from '@/lib/lifecycle/machine';
import { ComplaintStatus } from '@/generated/prisma/enums';

const StatusBody = z.object({
  status: z.enum(ComplaintStatus),
  /** The sentence the student reads. Some transitions refuse to run without it. */
  note: z.string().trim().max(2000).optional(),
});

/**
 * Move a complaint along §19's lifecycle. Every rule about *whether* the move is
 * allowed lives in `lifecycle/machine.ts`; this handler only decides whether the
 * caller owns the complaint and hands the rest over.
 *
 * An illegal move is a 409, not a 400 — the request was well-formed, the
 * complaint is simply not in a state where that can happen — and the response
 * names what the caller could have done instead.
 */
export async function POST(request: Request, { params }: RouteContext<'/api/complaints/[id]/status'>) {
  const session = await requireApiRole();
  if (session instanceof NextResponse) return session;

  const parsed = StatusBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'A valid status is required' }, { status: 400 });
  }

  const { id } = await params;
  const found = await loadForAction(id, session);
  if ('error' in found) return found.error;

  const outcome = await transition({
    complaintId: found.complaint.id,
    to: parsed.data.status,
    actor: { id: session.sub, role: session.role },
    note: parsed.data.note ?? null,
  });

  if (!outcome.ok) {
    const httpStatus = outcome.code === 'NOT_FOUND' ? 404 : outcome.code === 'FORBIDDEN' ? 403 : 409;
    return NextResponse.json({ error: outcome.reason, allowed: outcome.allowed }, { status: httpStatus });
  }

  return NextResponse.json({
    complaint: {
      id: outcome.complaintId,
      code: outcome.code,
      status: outcome.to,
      previousStatus: outcome.from,
    },
    narration: outcome.narration,
    allowed: nextStatuses(outcome.to, session.role).map((r) => ({ status: r.to, label: r.label })),
  });
}
