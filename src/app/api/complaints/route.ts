import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireApiRole } from '@/lib/auth/api';
import { getCategory } from '@/lib/engine/schemas';
import { evaluateCondition } from '@/lib/engine/condition';
import { createComplaint } from '@/lib/complaints/create';
import type { SlotValues } from '@/lib/engine/types';

const SlotValueSchema = z.object({
  value: z.unknown(),
  state: z.enum(['FILLED', 'UNKNOWN', 'SKIPPED']),
  source: z.enum(['EXTRACTED', 'ANSWERED', 'DEFAULTED']),
  confidence: z.number().min(0).max(1),
});

const CreateBody = z.object({
  categoryKey: z.string().min(1),
  locationId: z.string().nullable().optional(),
  slots: z.record(z.string(), SlotValueSchema),
  rawText: z.string().optional(),
  isAnonymous: z.boolean().optional(),
});

export async function POST(request: Request) {
  const session = await requireApiRole('STUDENT');
  if (session instanceof NextResponse) return session;

  const parsed = CreateBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid complaint payload', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const schema = getCategory(parsed.data.categoryKey);
  if (!schema) {
    return NextResponse.json({ error: 'Unknown category' }, { status: 400 });
  }

  // Every REQUIRED slot that is *currently relevant* must at least be resolved —
  // answered, unsure or defaulted. A REQUIRED slot whose askIf does not hold
  // (e.g. "is anyone at risk" when no hazard was reported) is not missing.
  const slots = parsed.data.slots as SlotValues;
  const missing = schema.slots
    .filter((s) => s.importance === 'REQUIRED')
    .filter((s) => evaluateCondition(s.askIf, slots))
    .filter((s) => !slots[s.key])
    .map((s) => s.key);
  if (missing.length > 0) {
    return NextResponse.json({ error: 'Missing required answers', missing }, { status: 400 });
  }

  const { complaint, routing, assessment } = await createComplaint({
    reporterId: session.sub,
    categoryKey: schema.key,
    locationId: parsed.data.locationId ?? null,
    slots,
    rawText: parsed.data.rawText,
    isAnonymous: parsed.data.isAnonymous,
  });

  return NextResponse.json(
    {
      complaint: {
        id: complaint.id,
        code: complaint.code,
        title: complaint.title,
        status: complaint.status,
        priority: complaint.priority,
        department: complaint.department?.name ?? null,
        location: complaint.location?.name ?? null,
        needsTriage: complaint.needsTriage,
      },
      routing,
      // §13/§14 — the caller sees the classification and the reasons for the
      // band, not just the band.
      classification: assessment.classification,
      priority: {
        band: assessment.priority.band,
        score: assessment.priority.score,
        reasons: assessment.priority.reasons,
        overrides: assessment.priority.overrides,
      },
    },
    { status: 201 },
  );
}

export async function GET() {
  const session = await requireApiRole();
  if (session instanceof NextResponse) return session;

  const where =
    session.role === 'STUDENT'
      ? { reporterId: session.sub }
      : session.role === 'ADMIN'
        ? {}
        : { departmentId: session.departmentId ?? '__none__' };

  const complaints = await prisma.complaint.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: { department: true, location: true },
  });

  return NextResponse.json({
    complaints: complaints.map((c) => ({
      id: c.id,
      code: c.code,
      title: c.title,
      status: c.status,
      priority: c.priority,
      categoryKey: c.categoryKey,
      department: c.department?.name ?? null,
      location: c.location?.name ?? null,
      createdAt: c.createdAt,
    })),
  });
}
