import { prisma } from '@/lib/db';
import { findCandidates } from '@/lib/dedup/candidates';
import { bestMatch, type DedupAttributes, type DedupCandidate, type DedupScore } from '@/lib/dedup/score';
import type { Classification } from '@/lib/engine/classify';
import { ancestryIndex } from '@/lib/locations';
import { incidentPriority } from './priority';
import type { CategorySchema } from '@/lib/engine/types';
import type { Prisma } from '@/generated/prisma/client';
import type { IncidentStatus } from '@/generated/prisma/enums';

/**
 * Incidents, spec §16–§18. The rule that shapes this whole file: **every
 * complaint belongs to exactly one incident** (plan.MD §6). A single-complaint
 * incident is just a complaint, and the UI hides the incident framing until it
 * has more than one member — which buys every later layer (dashboards, merges,
 * analytics) freedom from nullable-incident branching.
 *
 * The verdict itself is deterministic (CLAUDE.md §5): the LLM never sees a dedup
 * decision. Attributes in, weights applied, threshold compared.
 */

export type IncidentAttachment = {
  incidentId: string;
  incidentCode: string;
  incidentTitle: string;
  incidentStatus: IncidentStatus;
  /** Distinct students who have reported this issue (§18). */
  affectedCount: number;
  /** True when this complaint opened the incident rather than joining one. */
  isNew: boolean;
  verdict: 'AUTO_LINKED' | 'SUGGESTED' | 'NEW';
  score: number;
  /** The near-miss a staff member is asked to rule on (0.45–0.70). */
  suggestion: { incidentId: string; incidentCode: string; score: number; explain: string[] } | null;
};

export async function nextIncidentCode(): Promise<string> {
  const rows = await prisma.$queryRaw<{ nextval: bigint }[]>`
    SELECT nextval('incident_code_seq')
  `;
  return `INC-${String(rows[0].nextval).padStart(3, '0')}`;
}

/**
 * §17's naming: "CSE Block Wi-Fi Outage" — where, then what. Deterministic on
 * purpose. An incident title is read by staff as an identifier across a queue,
 * so it is built from the classification rather than written by the LLM; the
 * per-complaint title is where prose belongs.
 */
export function buildIncidentTitle(classification: Classification): string {
  const problem = classification.subcategoryLabel ?? classification.categoryLabel;
  return classification.locationName ? `${classification.locationName} — ${problem}` : problem;
}

/**
 * The one entry point used at submission. Finds candidates, scores them, and
 * either joins the winning incident or opens a new one — always leaving the
 * complaint with exactly one incident.
 */
export async function attachToIncident(input: {
  complaintId: string;
  complaintCode: string;
  reporterId: string;
  title: string;
  description: string;
  createdAt: Date;
  schema: CategorySchema;
  classification: Classification;
}): Promise<IncidentAttachment> {
  const { classification, schema } = input;
  const windowHours = schema.dedupWindowHours;

  const ancestry = classification.locationId ? await ancestryIndex() : null;
  const subject: DedupAttributes = {
    categoryKey: classification.categoryKey,
    subcategoryKey: classification.subcategoryKey,
    scopeBucket: classification.scopeBucket,
    locationId: classification.locationId,
    locationAncestorIds: classification.locationId
      ? (ancestry?.get(classification.locationId) ?? [classification.locationId])
      : [],
    createdAt: input.createdAt,
  };

  const candidates = await findCandidates({
    categoryKey: classification.categoryKey,
    complaintId: input.complaintId,
    title: input.title,
    description: input.description,
    createdAt: input.createdAt,
    windowHours,
  });

  const best = bestMatch(subject, candidates, windowHours);

  if (best && best.result.verdict === 'AUTO_LINKED') {
    const incident = await linkToIncident({
      complaintId: input.complaintId,
      incidentId: best.candidate.incidentId,
      score: best.result.score,
      verdict: 'AUTO_LINKED',
      actorId: null,
      message: dedupMessage(best.candidate, best.result),
      meta: dedupMeta(best.candidate, best.result, windowHours),
    });

    return {
      incidentId: incident.id,
      incidentCode: incident.code,
      incidentTitle: incident.title,
      incidentStatus: incident.status,
      affectedCount: incident.affectedCount,
      isNew: false,
      verdict: 'AUTO_LINKED',
      score: best.result.score,
      suggestion: null,
    };
  }

  // Below the auto-link line the complaint opens its own incident either way —
  // the difference is whether staff are asked to look at the near-miss (§41's
  // confidence-based human review, applied to dedup).
  const suggested = best && best.result.verdict === 'SUGGESTED' ? best : null;

  const incident = await createIncidentFor({
    complaintId: input.complaintId,
    classification,
    score: suggested?.result.score ?? 0,
  });

  if (suggested) {
    const candidateIncident = await prisma.incident.findUnique({
      where: { id: suggested.candidate.incidentId },
      select: { id: true, code: true, title: true },
    });

    await prisma.complaintEvent.create({
      data: {
        complaintId: input.complaintId,
        type: 'DUPLICATE_SUGGESTED',
        // Staff decide; the student is not shown an unresolved maybe (§39).
        isInternal: true,
        message: `Possible duplicate of ${candidateIncident?.code ?? 'an open incident'} — ${suggested.result.explain.join(', ')}`,
        meta: {
          ...dedupMeta(suggested.candidate, suggested.result, windowHours),
          suggestedIncidentId: suggested.candidate.incidentId,
          suggestedIncidentCode: candidateIncident?.code ?? null,
        },
      },
    });

    return {
      incidentId: incident.id,
      incidentCode: incident.code,
      incidentTitle: incident.title,
      incidentStatus: incident.status,
      affectedCount: incident.affectedCount,
      isNew: true,
      verdict: 'SUGGESTED',
      score: suggested.result.score,
      suggestion: candidateIncident
        ? {
            incidentId: candidateIncident.id,
            incidentCode: candidateIncident.code,
            score: suggested.result.score,
            explain: suggested.result.explain,
          }
        : null,
    };
  }

  return {
    incidentId: incident.id,
    incidentCode: incident.code,
    incidentTitle: incident.title,
    incidentStatus: incident.status,
    affectedCount: incident.affectedCount,
    isNew: true,
    verdict: 'NEW',
    score: best?.result.score ?? 0,
    suggestion: null,
  };
}

async function createIncidentFor(input: {
  complaintId: string;
  classification: Classification;
  score: number;
}) {
  const code = await nextIncidentCode();

  const incident = await prisma.incident.create({
    data: {
      code,
      title: buildIncidentTitle(input.classification),
      categoryKey: input.classification.categoryKey,
      locationId: input.classification.locationId,
      signature: input.classification.signature,
      status: 'OPEN',
      affectedCount: 1,
      priority: 'MEDIUM',
    },
  });

  await prisma.complaint.update({
    where: { id: input.complaintId },
    data: { incidentId: incident.id, dedupVerdict: 'NEW', dedupScore: input.score },
  });

  return recountIncident(incident.id);
}

/**
 * Move a complaint into an incident and roll the incident's counters forward.
 * Shared by the automatic link and the staff merge so the two can never drift —
 * a merged complaint is scored, counted and priced exactly like an auto-linked
 * one.
 */
export async function linkToIncident(input: {
  complaintId: string;
  incidentId: string;
  score: number;
  verdict: 'AUTO_LINKED' | 'SUGGESTED';
  actorId: string | null;
  message: string;
  meta?: Prisma.InputJsonValue;
}) {
  const previous = await prisma.complaint.findUnique({
    where: { id: input.complaintId },
    select: { incidentId: true },
  });

  await prisma.complaint.update({
    where: { id: input.complaintId },
    data: {
      incidentId: input.incidentId,
      dedupVerdict: input.verdict,
      dedupScore: input.score,
    },
  });

  await prisma.complaintEvent.create({
    data: {
      complaintId: input.complaintId,
      type: 'LINKED_TO_INCIDENT',
      actorId: input.actorId,
      message: input.message,
      meta: input.meta ?? {},
    },
  });

  // The complaint left its old incident, which may now be empty. Every complaint
  // has exactly one incident, so an emptied incident is not a record — it is a
  // leftover, and leaving it would inflate every incident count downstream.
  if (previous?.incidentId && previous.incidentId !== input.incidentId) {
    await collectEmptyIncident(previous.incidentId);
  }

  return recountIncident(input.incidentId);
}

/**
 * Staff ruling on a suggested duplicate (§41). Deliberately the same code path
 * as an auto-link, with an actor attached so the timeline records who decided.
 */
export async function mergeIntoIncident(input: {
  complaintId: string;
  incidentId: string;
  actorId: string;
}) {
  const [complaint, incident] = await Promise.all([
    prisma.complaint.findUnique({
      where: { id: input.complaintId },
      select: { id: true, code: true, incidentId: true, dedupScore: true },
    }),
    prisma.incident.findUnique({
      where: { id: input.incidentId },
      select: { id: true, code: true },
    }),
  ]);

  if (!complaint) return { error: 'Complaint not found' as const };
  if (!incident) return { error: 'Incident not found' as const };
  if (complaint.incidentId === incident.id) return { error: 'Already linked' as const };

  const updated = await linkToIncident({
    complaintId: complaint.id,
    incidentId: incident.id,
    score: complaint.dedupScore,
    verdict: 'AUTO_LINKED',
    actorId: input.actorId,
    message: `Merged into ${incident.code} — confirmed as a duplicate by staff`,
    meta: { confirmedBy: input.actorId, previousIncidentId: complaint.incidentId },
  });

  return { incident: updated };
}

/**
 * Recompute what an incident says about itself from its members: the affected
 * count and the rolled-up priority.
 *
 * `affectedCount` counts **distinct reporters**, not complaints — §18 says "47
 * students have reported this issue", and one student filing twice is one
 * affected student.
 */
export async function recountIncident(incidentId: string) {
  const members = await prisma.complaint.findMany({
    where: { incidentId },
    select: { reporterId: true, priority: true },
  });

  const affectedCount = new Set(members.map((m) => m.reporterId)).size;
  const rollup = incidentPriority(
    members.map((m) => m.priority),
    affectedCount,
  );

  return prisma.incident.update({
    where: { id: incidentId },
    data: { affectedCount, priority: rollup.priority },
  });
}

async function collectEmptyIncident(incidentId: string) {
  const remaining = await prisma.complaint.count({ where: { incidentId } });
  if (remaining === 0) {
    await prisma.incident.delete({ where: { id: incidentId } });
    return;
  }
  await recountIncident(incidentId);
}

function dedupMessage(candidate: DedupCandidate, result: DedupScore) {
  return `Linked as a duplicate of ${candidate.complaintCode} — ${result.explain.join(', ')}`;
}

function dedupMeta(candidate: DedupCandidate, result: DedupScore, windowHours: number) {
  return {
    dedupScore: result.score,
    // Spread rather than nest the interface: Prisma's InputJsonValue wants an
    // index signature, and the parts are a flat record of numbers anyway.
    dedupParts: { ...result.parts },
    matchedComplaintId: candidate.complaintId,
    matchedComplaintCode: candidate.complaintCode,
    windowHours,
  };
}
