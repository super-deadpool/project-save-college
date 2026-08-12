import { prisma } from '@/lib/db';
import { getCategory } from '@/lib/engine/schemas';
import { buildDescription } from '@/lib/engine/summary';
import { getLlmProvider } from '@/lib/llm';
import { generateTitle } from '@/lib/llm/title';
import { getLocationAncestry } from '@/lib/locations';
import { assessComplaint, type Assessment } from './assess';
import type { SlotValues } from '@/lib/engine/types';

export interface CreateComplaintInput {
  reporterId: string;
  categoryKey: string;
  locationId: string | null;
  slots: SlotValues;
  rawText?: string;
  isAnonymous?: boolean;
  /** Flags gaps the conversation could not close, on top of any routing doubt. */
  needsTriage?: boolean;
  /**
   * Reuse of an assessment already computed for the pre-submission summary, so
   * the student is not shown one priority and given another. Recomputed when
   * absent.
   */
  assessment?: Assessment;
}

export async function nextComplaintCode(): Promise<string> {
  const rows = await prisma.$queryRaw<{ nextval: bigint }[]>`
    SELECT nextval('complaint_code_seq')
  `;
  return `CMP-${String(rows[0].nextval).padStart(4, '0')}`;
}

export async function createComplaint(input: CreateComplaintInput) {
  const schema = getCategory(input.categoryKey);
  if (!schema) throw new Error(`Unknown category: ${input.categoryKey}`);

  const assessment =
    input.assessment ??
    (await assessComplaint(schema, input.slots, { locationId: input.locationId }));
  const { classification, priority, routing } = assessment;

  const location = await getLocationAncestry(input.locationId);

  const code = await nextComplaintCode();
  // Prose only: the LLM writes a nicer label, `buildTitle` writes a correct one.
  const title = await generateTitle(
    getLlmProvider(),
    schema,
    input.slots,
    location?.name,
    input.rawText ?? '',
  );
  const description = buildDescription(schema, input.slots, input.rawText ?? '', location?.name);

  const complaint = await prisma.complaint.create({
    data: {
      code,
      title,
      description,
      categoryKey: classification.categoryKey,
      subcategoryKey: classification.subcategoryKey,
      locationId: location?.id ?? null,
      reporterId: input.reporterId,
      departmentId: routing.departmentId,
      routingScore: routing.confidence,
      needsTriage: routing.needsTriage || Boolean(input.needsTriage),
      priority: priority.band,
      priorityScore: priority.score,
      priorityReasons: priority.reasons as never,
      signature: classification.signature,
      slots: input.slots as never,
      isAnonymous: input.isAnonymous ?? false,
      status: 'SUBMITTED',
      events: {
        create: {
          type: 'CREATED',
          actorId: input.reporterId,
          message: `${priority.band} priority — ${priority.reasons[0]?.label ?? 'assessed by the priority rubric'} ${routing.reason}`,
          meta: {
            priorityScore: priority.score,
            priorityOverrides: priority.overrides,
            routingConfidence: routing.confidence,
            matchedRuleId: routing.matchedRuleId,
            classificationConfidence: classification.confidence,
            signature: classification.signature,
            recurrenceCount: assessment.recurrenceCount,
          },
        },
      },
    },
    include: { department: true, location: true },
  });

  return { complaint, routing, assessment };
}
