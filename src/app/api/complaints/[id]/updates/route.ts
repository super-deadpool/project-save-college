import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireApiRole } from '@/lib/auth/api';
import { loadForAction } from '@/lib/complaints/access';
import { recordEvent, transition } from '@/lib/lifecycle/transition';

const UpdateBody = z.object({
  kind: z.enum(['PROGRESS', 'INFO_REQUEST', 'INFO_RESPONSE']),
  message: z.string().trim().min(1).max(2000),
  /** Staff notes the student should not see. Never applies to a request for information. */
  isInternal: z.boolean().optional(),
});

/**
 * §21's "add progress updates" and "request additional information", and the
 * student's half of the second one.
 *
 * Each writes an event *and* moves the complaint, because in this system those
 * are the same fact: work reported is work in progress, a question asked is a
 * complaint waiting for its answer. Doing them separately is what lets a status
 * drift away from what the timeline says happened.
 */
export async function POST(request: Request, { params }: RouteContext<'/api/complaints/[id]/updates'>) {
  const session = await requireApiRole();
  if (session instanceof NextResponse) return session;

  const parsed = UpdateBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'kind and a non-empty message are required' }, { status: 400 });
  }
  const { kind, message } = parsed.data;

  const { id } = await params;
  const found = await loadForAction(id, session);
  if ('error' in found) return found.error;
  const complaint = found.complaint;

  const isStudent = session.role === 'STUDENT';
  if (isStudent !== (kind === 'INFO_RESPONSE')) {
    return NextResponse.json(
      { error: isStudent ? 'Students may only reply to a request' : 'Staff cannot reply on a student’s behalf' },
      { status: 403 },
    );
  }

  if (kind === 'INFO_RESPONSE') {
    if (complaint.status !== 'WAITING_FOR_STUDENT') {
      return NextResponse.json({ error: 'Nothing has been asked of you yet' }, { status: 409 });
    }
    await recordEvent({
      complaintId: complaint.id,
      type: 'INFO_PROVIDED',
      actorId: session.sub,
      message,
    });
    const outcome = await transition({
      complaintId: complaint.id,
      to: 'IN_PROGRESS',
      actor: { id: session.sub, role: session.role },
    });
    return NextResponse.json({
      complaint: { id: complaint.id, code: complaint.code, status: outcome.ok ? outcome.to : complaint.status },
    });
  }

  if (kind === 'INFO_REQUEST') {
    await recordEvent({
      complaintId: complaint.id,
      type: 'INFO_REQUESTED',
      actorId: session.sub,
      message,
    });
    const outcome = await transition({
      complaintId: complaint.id,
      to: 'WAITING_FOR_STUDENT',
      actor: { id: session.sub, role: session.role },
      note: message,
    });
    if (!outcome.ok) {
      return NextResponse.json({ error: outcome.reason, allowed: outcome.allowed }, { status: 409 });
    }
    return NextResponse.json({
      complaint: { id: complaint.id, code: complaint.code, status: outcome.to },
    });
  }

  // The update comes first so the feed reads cause then effect: the note about
  // the lamp module, then "Investigation started".
  await recordEvent({
    complaintId: complaint.id,
    type: 'PROGRESS_UPDATE',
    actorId: session.sub,
    message,
    isInternal: parsed.data.isInternal ?? false,
  });

  // A progress update on a complaint nobody has accepted yet would leave
  // `respondedAt` unset — the exact stamp Layer 8 measures against — so the
  // acknowledgement it implies is recorded rather than skipped.
  let status = complaint.status;
  if (status === 'ASSIGNED' || status === 'REOPENED') {
    const accepted = await transition({
      complaintId: complaint.id,
      to: 'ACKNOWLEDGED',
      actor: { id: session.sub, role: session.role },
      assigneeId: session.sub,
    });
    if (accepted.ok) status = accepted.to;
  }
  if (status === 'ACKNOWLEDGED') {
    const started = await transition({
      complaintId: complaint.id,
      to: 'IN_PROGRESS',
      actor: { id: session.sub, role: session.role },
    });
    if (started.ok) status = started.to;
  }

  return NextResponse.json({ complaint: { id: complaint.id, code: complaint.code, status } });
}
