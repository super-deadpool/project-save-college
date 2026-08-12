import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import type { SessionPayload } from '@/lib/auth/jwt';

/**
 * Who may *act* on a complaint, as opposed to who may read one.
 *
 * The distinction that matters: a student who is not the reporter gets a 404,
 * because confirming the complaint exists tells them something they should not
 * know. A staff member from the wrong department gets a 403, because they know
 * perfectly well the complaint exists — they just do not own it (§21).
 */
export async function loadForAction(complaintId: string, session: SessionPayload) {
  const complaint = await prisma.complaint.findUnique({
    where: { id: complaintId },
    select: {
      id: true,
      code: true,
      status: true,
      departmentId: true,
      reporterId: true,
      assigneeId: true,
      incidentId: true,
    },
  });

  if (!complaint) {
    return { error: NextResponse.json({ error: 'Complaint not found' }, { status: 404 }) };
  }

  if (session.role === 'ADMIN') return { complaint };

  if (session.role === 'STUDENT') {
    if (complaint.reporterId !== session.sub) {
      return { error: NextResponse.json({ error: 'Complaint not found' }, { status: 404 }) };
    }
    return { complaint };
  }

  if (session.departmentId == null || complaint.departmentId !== session.departmentId) {
    return { error: NextResponse.json({ error: 'Not your department' }, { status: 403 }) };
  }
  return { complaint };
}
