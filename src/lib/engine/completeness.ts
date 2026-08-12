import { evaluateCondition } from './condition';
import { askableSlots, selectNextSlot } from './next-question';
import type { CategorySchema, Slot, SlotValues } from './types';

/** After this many questions we stop chasing RECOMMENDED slots (§6). */
export const MAX_RECOMMENDED_QUESTIONS = 6;

export interface CompletenessInput {
  slots: SlotValues;
  askedSlots: string[];
}

export type StopReason =
  | 'SAFETY_SHORT_CIRCUIT'
  | 'ENOUGH_INFORMATION'
  | 'QUESTION_BUDGET_REACHED'
  | 'NOTHING_LEFT_TO_ASK';

export interface Completeness {
  complete: boolean;
  reason: StopReason | null;
  /** Set when a safety-critical answer indicates live danger. */
  safetyShortCircuit: boolean;
  missingRequired: string[];
  nextSlot: Slot | null;
}

/**
 * §3 short-circuit: a safetyCritical slot answered with a danger value stops
 * questioning immediately — the complaint goes out as CRITICAL.
 */
export function hasSafetyShortCircuit(schema: CategorySchema, slots: SlotValues): boolean {
  return schema.slots.some((slot) => {
    if (!slot.safetyCritical || !slot.criticalValues) return false;
    const entry = slots[slot.key];
    if (!entry || entry.state !== 'FILLED') return false;
    const values = Array.isArray(entry.value) ? entry.value : [entry.value];
    return values.some((v) => slot.criticalValues!.includes(v));
  });
}

export function evaluateCompleteness(
  schema: CategorySchema,
  ctx: CompletenessInput,
): Completeness {
  const safetyShortCircuit = hasSafetyShortCircuit(schema, ctx.slots);

  const missingRequired = schema.slots
    .filter((s) => s.importance === 'REQUIRED')
    .filter((s) => evaluateCondition(s.askIf, ctx.slots))
    .filter((s) => ctx.slots[s.key] === undefined)
    .map((s) => s.key);

  if (safetyShortCircuit) {
    return {
      complete: true,
      reason: 'SAFETY_SHORT_CIRCUIT',
      safetyShortCircuit,
      missingRequired,
      nextSlot: null,
    };
  }

  const nextSlot = selectNextSlot(schema, ctx);

  if (missingRequired.length > 0) {
    return { complete: false, reason: null, safetyShortCircuit, missingRequired, nextSlot };
  }

  const remainingRecommended = askableSlots(schema, ctx).filter(
    (s) => s.importance === 'RECOMMENDED',
  );

  if (remainingRecommended.length === 0) {
    return {
      complete: true,
      reason: nextSlot ? 'ENOUGH_INFORMATION' : 'NOTHING_LEFT_TO_ASK',
      safetyShortCircuit,
      missingRequired,
      nextSlot: null,
    };
  }

  if (ctx.askedSlots.length >= MAX_RECOMMENDED_QUESTIONS) {
    return {
      complete: true,
      reason: 'QUESTION_BUDGET_REACHED',
      safetyShortCircuit,
      missingRequired,
      nextSlot: null,
    };
  }

  return { complete: false, reason: null, safetyShortCircuit, missingRequired, nextSlot };
}
