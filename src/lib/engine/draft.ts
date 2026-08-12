import { evaluateCondition } from './condition';
import { evaluateCompleteness, type Completeness } from './completeness';
import type { CategorySchema, DraftState, Slot, SlotValue, SlotValues, Turn } from './types';

/**
 * The conversation as a pure state machine: draft state in, new draft state out.
 * Persistence (ComplaintDraft) and rendering live outside this module.
 */

export type AnswerInput =
  | { kind: 'VALUE'; value: unknown }
  | { kind: 'UNSURE' }
  | { kind: 'SKIP' };

export function emptyDraft(rawText = ''): DraftState {
  return { rawText, categoryKey: null, slots: {}, askedSlots: [], turns: [] };
}

export function addTurn(state: DraftState, turn: Omit<Turn, 'at'>, at: string): DraftState {
  return { ...state, turns: [...state.turns, { ...turn, at }] };
}

/** Merge extractor output without overwriting anything the student answered. */
export function mergeExtracted(
  schema: CategorySchema,
  state: DraftState,
  extracted: SlotValues,
): DraftState {
  const slots: SlotValues = { ...state.slots };
  for (const [key, value] of Object.entries(extracted)) {
    const existing = slots[key];
    if (existing && existing.source === 'ANSWERED') continue;
    slots[key] = value;
  }
  return prune(schema, { ...state, slots });
}

export function applyAnswer(
  schema: CategorySchema,
  state: DraftState,
  slotKey: string,
  answer: AnswerInput,
): DraftState {
  const slot = schema.slots.find((s) => s.key === slotKey);
  if (!slot) return state;

  const value = resolveAnswer(slot, answer);
  const slots: SlotValues = { ...state.slots, [slotKey]: value };
  const askedSlots = state.askedSlots.includes(slotKey)
    ? state.askedSlots
    : [...state.askedSlots, slotKey];

  return prune(schema, { ...state, slots, askedSlots });
}

function resolveAnswer(slot: Slot, answer: AnswerInput): SlotValue {
  if (answer.kind === 'SKIP') {
    return { value: null, state: 'SKIPPED', source: 'ANSWERED', confidence: 1 };
  }
  if (answer.kind === 'UNSURE') {
    // §10 — "I'm not sure" is recorded, never blocking. A REQUIRED slot falls
    // back to a coarser default so the student can still submit.
    if (slot.importance === 'REQUIRED' && slot.unsureDefault !== undefined) {
      return {
        value: slot.unsureDefault,
        state: 'UNKNOWN',
        source: 'DEFAULTED',
        confidence: 0.3,
      };
    }
    return { value: null, state: 'UNKNOWN', source: 'ANSWERED', confidence: 0.3 };
  }
  return { value: answer.value, state: 'FILLED', source: 'ANSWERED', confidence: 1 };
}

/**
 * Re-answering a slot invalidates downstream answers whose askIf no longer
 * holds, and lets them be asked again if they become relevant later (§12 edit).
 */
export function clearAnswer(
  schema: CategorySchema,
  state: DraftState,
  slotKey: string,
): DraftState {
  const slots = { ...state.slots };
  delete slots[slotKey];
  const askedSlots = state.askedSlots.filter((k) => k !== slotKey);
  return prune(schema, { ...state, slots, askedSlots });
}

/** Drop values (and asked-marks) for slots whose askIf no longer passes. */
function prune(schema: CategorySchema, state: DraftState): DraftState {
  const slots = { ...state.slots };
  let askedSlots = [...state.askedSlots];
  let changed = true;

  // Removing one answer can invalidate another, so iterate to a fixed point.
  while (changed) {
    changed = false;
    for (const slot of schema.slots) {
      if (!slot.askIf) continue;
      if (evaluateCondition(slot.askIf, slots)) continue;
      if (slots[slot.key] !== undefined) {
        delete slots[slot.key];
        changed = true;
      }
      if (askedSlots.includes(slot.key)) {
        askedSlots = askedSlots.filter((k) => k !== slot.key);
        changed = true;
      }
    }
  }

  return { ...state, slots, askedSlots };
}

export type Step =
  | { kind: 'CATEGORY' }
  | { kind: 'QUESTION'; slot: Slot; completeness: Completeness }
  | { kind: 'SUMMARY'; completeness: Completeness };

export function nextStep(schema: CategorySchema | null, state: DraftState): Step {
  if (!schema) return { kind: 'CATEGORY' };

  const completeness = evaluateCompleteness(schema, {
    slots: state.slots,
    askedSlots: state.askedSlots,
  });

  if (completeness.complete || !completeness.nextSlot) {
    return { kind: 'SUMMARY', completeness };
  }
  return { kind: 'QUESTION', slot: completeness.nextSlot, completeness };
}

/** Mark a slot as asked so it is not offered twice if the student ignores it. */
export function markAsked(state: DraftState, slotKey: string): DraftState {
  if (state.askedSlots.includes(slotKey)) return state;
  return { ...state, askedSlots: [...state.askedSlots, slotKey] };
}
