import { prisma } from '@/lib/db';
import { classify, type Classification } from '@/lib/engine/classify';
import { hasSafetyShortCircuit } from '@/lib/engine/completeness';
import { assessPriority, studentReasons, type PriorityResult } from '@/lib/engine/priority';
import { resolveRouting, type RoutingDecision, type RoutingRuleInput } from '@/lib/engine/routing';
import { getLocationAncestry } from '@/lib/locations';
import type { CategorySchema, SlotValues } from '@/lib/engine/types';

/**
 * The one place a complaint's classification, priority and department are
 * decided (§13, §14, §15). Everything decision-shaped lives in the pure engine
 * modules; this only fetches what they need — location facts, routing rules and
 * the recurrence history — and stitches the three results together.
 *
 * Both the pre-submission summary and the actual submission call this, so the
 * student is shown exactly what gets persisted rather than a lookalike estimate.
 */

/** plan.MD §4 — a signature seen this often within the window counts as recurring. */
export const RECURRENCE_WINDOW_DAYS = 30;

export interface Assessment {
  classification: Classification;
  priority: PriorityResult;
  routing: RoutingDecision;
  departmentName: string | null;
  recurrenceCount: number;
  safetyShortCircuit: boolean;
}

export interface AssessOptions {
  locationId?: string | null;
  /** Set when re-assessing an existing complaint so it does not count itself. */
  excludeComplaintId?: string;
  now?: Date;
}

export async function assessComplaint(
  schema: CategorySchema,
  slots: SlotValues,
  options: AssessOptions = {},
): Promise<Assessment> {
  const location = await getLocationAncestry(options.locationId);

  // Signature depends only on the classification, so classify first, then count.
  const classification = classify(
    schema,
    slots,
    location
      ? {
          id: location.id,
          name: location.name,
          type: location.type,
          criticality: location.criticality,
        }
      : null,
  );

  const [recurrenceCount, rules] = await Promise.all([
    countRecurrence(classification.signature, options),
    prisma.routingRule.findMany() as unknown as Promise<RoutingRuleInput[]>,
  ]);

  const safetyShortCircuit = hasSafetyShortCircuit(schema, slots);

  const priority = assessPriority({ classification, safetyShortCircuit, recurrenceCount });

  const routing = resolveRouting(rules, {
    categoryKey: classification.categoryKey,
    subcategoryKey: classification.subcategoryKey,
    locationIds: location?.ancestorIds ?? [],
    locationType: location?.type ?? null,
  });

  const department = routing.departmentId
    ? await prisma.department.findUnique({ where: { id: routing.departmentId } })
    : null;

  return {
    classification,
    priority,
    routing,
    departmentName: department?.name ?? null,
    recurrenceCount,
    safetyShortCircuit,
  };
}

async function countRecurrence(signature: string, options: AssessOptions): Promise<number> {
  const since = new Date(options.now?.getTime() ?? Date.now());
  since.setDate(since.getDate() - RECURRENCE_WINDOW_DAYS);

  return prisma.complaint.count({
    where: {
      signature,
      createdAt: { gte: since },
      ...(options.excludeComplaintId ? { id: { not: options.excludeComplaintId } } : {}),
    },
  });
}

/**
 * What the student is told (§12): the band, why it was chosen, and who is
 * handling it. Routing uncertainty is deliberately not surfaced here — a low
 * confidence score is not something a student can act on (§39), so an unrouted
 * complaint reads as "the campus office will assign it" while staff and admin
 * views show the real figure and the triage flag.
 */
export function studentFacingAssessment(assessment: Assessment) {
  return {
    priority: assessment.priority.band,
    reasons: studentReasons(assessment.priority),
    departmentName: assessment.departmentName,
    categoryLabel: assessment.classification.categoryLabel,
    subcategoryLabel: assessment.classification.subcategoryLabel,
    safetyShortCircuit: assessment.safetyShortCircuit,
  };
}

export type StudentFacingAssessment = ReturnType<typeof studentFacingAssessment>;
