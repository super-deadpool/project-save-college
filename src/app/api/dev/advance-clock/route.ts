import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireApiRole } from '@/lib/auth/api';
import { ageComplaints } from '@/lib/sla/dev-clock';
import { scanSla } from '@/lib/sla/service';

/**
 * The demo clock (plan.MD §7 Layer 8).
 *
 * An SLA feature that takes an hour to show is a feature nobody sees. This
 * endpoint makes a complaint *older* — it shifts its own timestamps and those of
 * its events back by N minutes — so a promise made a minute ago can be a promise
 * broken two hours ago, and the escalation ladder plays out in seconds.
 *
 * Ageing rows rather than moving a global "now" is deliberate: every clock in the
 * system stays the real one, so nothing has to be threaded through the pure
 * modules, the worker in its own process agrees with the web app for free, and
 * one complaint can be aged without disturbing the rest of the campus.
 *
 * Dev-only, admin-only, and it refuses to run in production.
 */

const AdvanceBody = z.object({
  /** How much older to make the target. Positive minutes only. */
  minutes: z.number().int().positive().max(60 * 24 * 30),
  /** One complaint by code (CMP-0042) or id. Omit with `all` to age every open one. */
  code: z.string().trim().min(1).optional(),
  id: z.string().trim().min(1).optional(),
  all: z.boolean().optional(),
  /** Run §22's sweep straight afterwards, so one call shows the consequence. */
  scan: z.boolean().optional(),
});

export async function POST(request: Request) {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'Not available' }, { status: 404 });
  }

  const session = await requireApiRole('ADMIN');
  if (session instanceof NextResponse) return session;

  const parsed = AdvanceBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'minutes must be a positive integer' }, { status: 400 });
  }
  const { minutes, code, id, all, scan } = parsed.data;

  if (!code && !id && !all) {
    return NextResponse.json({ error: 'Name a complaint by code or id, or pass all: true' }, { status: 400 });
  }

  const targets = await prisma.complaint.findMany({
    where: code ? { code } : id ? { id } : {},
    select: { id: true, code: true },
  });
  if (targets.length === 0) {
    return NextResponse.json({ error: 'No such complaint' }, { status: 404 });
  }
  const ids = targets.map((t) => t.id);

  await ageComplaints(ids, minutes);

  const result = scan ? await scanSla() : null;

  const after = await prisma.complaint.findMany({
    where: { id: { in: ids } },
    select: {
      code: true,
      status: true,
      priority: true,
      createdAt: true,
      responseDueAt: true,
      resolutionDueAt: true,
      respondedAt: true,
      escalationLevel: true,
    },
    orderBy: { code: 'asc' },
    take: 20,
  });

  return NextResponse.json({
    aged: { minutes, complaints: targets.length },
    complaints: after,
    scan: result
      ? {
          scanned: result.scanned,
          breaching: result.breaching,
          escalated: result.escalated.map((e) => ({
            code: e.code,
            from: e.from,
            to: e.to,
            steps: e.steps.map((s) => ({ level: s.level, kind: s.kind, notify: s.notify, flagged: s.flagged })),
          })),
        }
      : null,
  });
}
