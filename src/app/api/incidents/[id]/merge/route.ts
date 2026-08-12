import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireApiRole } from '@/lib/auth/api';
import { mergeIntoIncident } from '@/lib/incidents/service';

const MergeBody = z.object({ complaintId: z.string().min(1) });

/**
 * Staff ruling on a suggested duplicate — the 0.45–0.70 band, where the system
 * is confident enough to raise the question and not confident enough to answer
 * it (§41). The merge itself runs the same code as an auto-link.
 */
export async function POST(
  request: Request,
  { params }: RouteContext<'/api/incidents/[id]/merge'>,
) {
  const session = await requireApiRole('STAFF', 'DEPT_MANAGER', 'ADMIN');
  if (session instanceof NextResponse) return session;

  const parsed = MergeBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'complaintId is required' }, { status: 400 });
  }

  const { id: incidentId } = await params;

  // Staff act inside their own department; admins act anywhere (§21).
  if (session.role !== 'ADMIN') {
    const complaint = await prisma.complaint.findUnique({
      where: { id: parsed.data.complaintId },
      select: { departmentId: true },
    });
    if (!complaint || complaint.departmentId !== session.departmentId) {
      return NextResponse.json({ error: 'Not your department' }, { status: 403 });
    }
  }

  const result = await mergeIntoIncident({
    complaintId: parsed.data.complaintId,
    incidentId,
    actorId: session.sub,
  });

  if ('error' in result) {
    return NextResponse.json({ error: result.error }, { status: result.error === 'Already linked' ? 409 : 404 });
  }

  return NextResponse.json({
    incident: {
      id: result.incident.id,
      code: result.incident.code,
      title: result.incident.title,
      priority: result.incident.priority,
      affectedCount: result.incident.affectedCount,
    },
  });
}
