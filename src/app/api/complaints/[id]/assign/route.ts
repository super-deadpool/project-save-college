import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireApiRole } from '@/lib/auth/api';
import { loadForAction } from '@/lib/complaints/access';
import { recordEvent, transition } from '@/lib/lifecycle/transition';

const AssignBody = z.discriminatedUnion('action', [
  /** A staff member takes the complaint on: assignee = self, and it moves to ACKNOWLEDGED. */
  z.object({ action: z.literal('ACCEPT') }),
  /** Hand it to a named colleague. Status does not change — ownership does. */
  z.object({ action: z.literal('ASSIGN'), assigneeId: z.string().min(1) }),
  /** §15's low-confidence case: a human picks the department the router could not. */
  z.object({ action: z.literal('ROUTE'), departmentId: z.string().min(1) }),
]);

/**
 * §21's "accept" and "assign", plus the triage route for a complaint the router
 * would not guess at. Three actions rather than three routes because they are
 * the same decision — who owns this — recorded three ways.
 */
export async function POST(request: Request, { params }: RouteContext<'/api/complaints/[id]/assign'>) {
  const session = await requireApiRole('STAFF', 'DEPT_MANAGER', 'ADMIN');
  if (session instanceof NextResponse) return session;

  const parsed = AssignBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'action must be ACCEPT, ASSIGN or ROUTE' }, { status: 400 });
  }
  const body = parsed.data;

  const { id } = await params;

  // A complaint waiting for triage has no department yet, so the ownership check
  // that guards every other action would lock out the very people meant to fix
  // that. Routing one is a manager/admin decision instead.
  if (body.action === 'ROUTE') {
    if (session.role === 'STAFF') {
      return NextResponse.json({ error: 'Only a manager can route a complaint' }, { status: 403 });
    }
    const department = await prisma.department.findUnique({
      where: { id: body.departmentId },
      select: { id: true, name: true },
    });
    if (!department) return NextResponse.json({ error: 'Department not found' }, { status: 404 });

    const outcome = await transition({
      complaintId: id,
      to: 'ASSIGNED',
      actor: { id: session.sub, role: session.role },
      departmentId: department.id,
      meta: { departmentName: department.name, routedByHand: true },
    });
    if (!outcome.ok) {
      return NextResponse.json(
        { error: outcome.reason, allowed: outcome.allowed },
        { status: outcome.code === 'NOT_FOUND' ? 404 : 409 },
      );
    }
    return NextResponse.json({
      complaint: { id, code: outcome.code, status: outcome.to, department: department.name },
    });
  }

  const found = await loadForAction(id, session);
  if ('error' in found) return found.error;
  const complaint = found.complaint;

  if (body.action === 'ACCEPT') {
    // Accepting a complaint that is already acknowledged is a reassignment to
    // self, not an error — the ladder only moves when there is a rung above.
    const outcome = await transition({
      complaintId: complaint.id,
      to: 'ACKNOWLEDGED',
      actor: { id: session.sub, role: session.role },
      assigneeId: session.sub,
      meta: { acceptedBy: session.name },
    });

    if (!outcome.ok) {
      if (outcome.code !== 'ILLEGAL') {
        return NextResponse.json({ error: outcome.reason, allowed: outcome.allowed }, { status: 403 });
      }
      await prisma.complaint.update({
        where: { id: complaint.id },
        data: { assigneeId: session.sub },
      });
      await recordEvent({
        complaintId: complaint.id,
        type: 'ASSIGNED',
        actorId: session.sub,
        message: `${session.name} took ownership`,
      });
      return NextResponse.json({
        complaint: { id: complaint.id, code: complaint.code, status: complaint.status },
        assignee: session.name,
      });
    }

    return NextResponse.json({
      complaint: { id: complaint.id, code: outcome.code, status: outcome.to },
      assignee: session.name,
    });
  }

  const assignee = await prisma.user.findUnique({
    where: { id: body.assigneeId },
    select: { id: true, name: true, role: true, departmentId: true },
  });
  if (!assignee || assignee.role === 'STUDENT') {
    return NextResponse.json({ error: 'Assignee must be a staff member' }, { status: 400 });
  }
  // Work belongs to the department that owns the complaint; handing it sideways
  // would put it in a queue nobody watching this complaint can see.
  if (assignee.departmentId !== complaint.departmentId) {
    return NextResponse.json({ error: 'Assignee is in another department' }, { status: 400 });
  }

  await prisma.complaint.update({
    where: { id: complaint.id },
    data: { assigneeId: assignee.id },
  });
  await recordEvent({
    complaintId: complaint.id,
    type: 'ASSIGNED',
    actorId: session.sub,
    message: `Assigned to ${assignee.name}`,
  });

  return NextResponse.json({
    complaint: { id: complaint.id, code: complaint.code, status: complaint.status },
    assignee: assignee.name,
  });
}
