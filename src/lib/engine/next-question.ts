import { evaluateCondition } from './condition';
import type { CategorySchema, Slot, SlotValues } from './types';

/**
 * Deterministic next-question selection (plan.MD §3).
 *
 *   score = safetyCritical ? 1000 : 0
 *         + importanceWeight            REQUIRED 100 · RECOMMENDED 40 · OPTIONAL 10
 *         + infoGain * 20
 *         + priorityDiscrimination      +15 when the answer can move the band
 *
 * Ties break on declaration order, so a transcript is stable and snapshot-testable.
 */

export const IMPORTANCE_WEIGHT = { REQUIRED: 100, RECOMMENDED: 40, OPTIONAL: 10 } as const;

export function scoreSlot(slot: Slot): number {
  return (
    (slot.safetyCritical ? 1000 : 0) +
    IMPORTANCE_WEIGHT[slot.importance] +
    slot.infoGain * 20 +
    (slot.priorityDiscriminating ? 15 : 0)
  );
}

/** A slot is resolved once it holds any value — answered, unsure or skipped. */
export function isResolved(slots: SlotValues, key: string): boolean {
  return slots[key] !== undefined;
}

export interface AskableContext {
  slots: SlotValues;
  askedSlots: string[];
}

/** Slots that are currently relevant, unresolved, and not already asked. */
export function askableSlots(schema: CategorySchema, ctx: AskableContext): Slot[] {
  return schema.slots.filter(
    (slot) =>
      !isResolved(ctx.slots, slot.key) &&
      !ctx.askedSlots.includes(slot.key) &&
      evaluateCondition(slot.askIf, ctx.slots),
  );
}

export function selectNextSlot(schema: CategorySchema, ctx: AskableContext): Slot | null {
  const candidates = askableSlots(schema, ctx);
  if (candidates.length === 0) return null;

  let best = candidates[0];
  let bestScore = scoreSlot(best);
  for (const slot of candidates.slice(1)) {
    const score = scoreSlot(slot);
    if (score > bestScore) {
      best = slot;
      bestScore = score;
    }
  }
  return best;
}
