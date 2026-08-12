import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireApiRole } from '@/lib/auth/api';
import { getCategory } from '@/lib/engine/schemas';
import { evaluateCondition } from '@/lib/engine/condition';
import { hasSafetyShortCircuit } from '@/lib/engine/completeness';
import { createComplaint } from '@/lib/complaints/create';
import { studentFacingAssessment } from '@/lib/complaints/assess';
import { incidentMessage, isSharedIncident } from '@/lib/incidents/message';
import { loadDraft, locationIdOf, toState } from '@/lib/drafts/service';
import type { SlotValues } from '@/lib/engine/types';

export async function POST(_request: Request, { params }: RouteContext<'/api/drafts/[id]/submit'>) {
  const session = await requireApiRole('STUDENT');
  if (session instanceof NextResponse) return session;

  const { id } = await params;
  const row = await loadDraft(id, session.sub);
  if (!row) return NextResponse.json({ error: 'Draft not found' }, { status: 404 });
  if (row.status !== 'DRAFT' || row.complaintId) {
    return NextResponse.json({ error: 'This draft was already submitted' }, { status: 409 });
  }

  const state = toState(row);
  const schema = getCategory(state.categoryKey);
  if (!schema) return NextResponse.json({ error: 'Pick a category first' }, { status: 400 });

  const shortCircuit = hasSafetyShortCircuit(schema, state.slots);
  const slots: SlotValues = { ...state.slots };
  const unresolved: string[] = [];

  for (const slot of schema.slots) {
    if (slot.importance !== 'REQUIRED') continue;
    if (!evaluateCondition(slot.askIf, slots)) continue;
    if (slots[slot.key] !== undefined) continue;
    unresolved.push(slot.key);
    // A live-danger report is never held up by unanswered questions — the gaps
    // are defaulted and the complaint is flagged for triage instead (§10).
    if (shortCircuit) {
      slots[slot.key] = {
        value: slot.unsureDefault ?? null,
        state: 'UNKNOWN',
        source: 'DEFAULTED',
        confidence: 0.2,
      };
    }
  }

  if (unresolved.length > 0 && !shortCircuit) {
    return NextResponse.json({ error: 'Some required answers are missing', unresolved }, { status: 400 });
  }

  // The rubric reads the same short-circuit signal, so live danger still submits
  // as CRITICAL — via one code path rather than a special case here (§14).
  const { complaint, assessment, incident } = await createComplaint({
    reporterId: session.sub,
    categoryKey: schema.key,
    locationId: locationIdOf(slots),
    slots,
    rawText: state.rawText,
    needsTriage: unresolved.length > 0,
  });

  await prisma.complaintDraft.update({
    where: { id: row.id },
    data: { status: 'SUBMITTED', complaintId: complaint.id, slots: slots as never },
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
        needsTriage: complaint.needsTriage,
      },
      assessment: studentFacingAssessment(assessment),
      // §36 — when the issue is already known, the acknowledgement says so.
      // `message` is null for a solitary report: a size-1 incident is invisible
      // to the student, who is simply told their complaint was received.
      incident: {
        id: incident.incidentId,
        code: incident.incidentCode,
        title: incident.incidentTitle,
        affectedCount: incident.affectedCount,
        isNew: incident.isNew,
        message: isSharedIncident(incident.affectedCount)
          ? incidentMessage({
              code: incident.incidentCode,
              title: incident.incidentTitle,
              status: incident.incidentStatus,
              priority: complaint.priority,
              affectedCount: incident.affectedCount,
              departmentName: complaint.department?.name ?? null,
            })
          : null,
      },
      safetyShortCircuit: shortCircuit,
    },
    { status: 201 },
  );
}
