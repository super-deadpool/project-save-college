import { describe, expect, it } from 'vitest';
import { getCategory } from '@/lib/engine/schemas';
import { extractFromText } from '@/lib/engine/extract';
import { applyAnswer, emptyDraft, mergeExtracted, nextStep, type AnswerInput } from '@/lib/engine/draft';
import { classify } from '@/lib/engine/classify';
import { hasSafetyShortCircuit } from '@/lib/engine/completeness';
import { assessPriority } from '@/lib/engine/priority';
import type { CategorySchema, DraftState } from '@/lib/engine/types';

/**
 * The breadth-pass categories held to the same standard as WiFi and Electrical
 * (Layer 2's gate): safety questions first, a short-circuit that actually stops
 * the conversation, and conditional slots that stay out of the way.
 */

const LOCATIONS = [
  { id: 'loc-mess-a', name: 'Boys Hostel A Mess' },
  { id: 'loc-hostel-a', name: 'Boys Hostel A' },
  { id: 'loc-cse', name: 'CSE Block' },
];

function start(text: string): { schema: CategorySchema; state: DraftState } {
  const extraction = extractFromText(text, null, { locations: LOCATIONS });
  const schema = getCategory(extraction.categoryKey);
  if (!schema) throw new Error(`No category matched: ${text}`);
  return { schema, state: mergeExtracted(schema, emptyDraft(text), extraction.slots) };
}

function transcript(
  schema: CategorySchema,
  initial: DraftState,
  answers: Record<string, AnswerInput>,
  maxTurns = 12,
) {
  const asked: string[] = [];
  let state = initial;

  for (let i = 0; i < maxTurns; i++) {
    const step = nextStep(schema, state);
    if (step.kind !== 'QUESTION') return { asked, state, step };
    asked.push(step.slot.key);
    state = applyAnswer(schema, state, step.slot.key, answers[step.slot.key] ?? { kind: 'SKIP' });
  }
  throw new Error('Conversation did not terminate');
}

describe('hostel food (§5 — hostel, meal, date, issue, recurring)', () => {
  it('pre-fills the problem from the report and asks the health question first', () => {
    const { schema, state } = start('the mess food was stale at dinner in Boys Hostel A Mess');

    expect(schema.key).toBe('HOSTEL_FOOD');
    expect(state.slots.problem_type).toMatchObject({ value: 'STALE', source: 'EXTRACTED' });
    expect(state.slots.location).toMatchObject({ value: 'loc-mess-a' });
    expect(state.slots.meal).toMatchObject({ value: 'DINNER' });

    const step = nextStep(schema, state);
    expect(step.kind).toBe('QUESTION');
    if (step.kind === 'QUESTION') expect(step.slot.key).toBe('health_impact');
  });

  it('stops asking the moment several students are reported ill', () => {
    const { schema, state } = start('the mess food was stale at dinner');
    const withIllness = applyAnswer(schema, state, 'health_impact', {
      kind: 'VALUE',
      value: 'MULTIPLE_UNWELL',
    });

    const step = nextStep(schema, withIllness);
    expect(step.kind).toBe('SUMMARY');
    if (step.kind === 'SUMMARY') {
      expect(step.completeness.safetyShortCircuit).toBe(true);
      expect(step.completeness.reason).toBe('SAFETY_SHORT_CIRCUIT');
    }

    // …and the rubric agrees, so the halted conversation submits as CRITICAL.
    const slots = withIllness.slots;
    expect(
      assessPriority({
        classification: classify(schema, slots, null),
        safetyShortCircuit: hasSafetyShortCircuit(schema, slots),
      }).band,
    ).toBe('CRITICAL');
  });

  it('runs to a summary with nobody unwell, asking a bounded set of questions', () => {
    const { schema, state } = start('the mess food was stale at dinner');
    const run = transcript(schema, state, {
      health_impact: { kind: 'VALUE', value: 'NOBODY_UNWELL' },
      location: { kind: 'VALUE', value: 'loc-mess-a' },
      meal: { kind: 'VALUE', value: 'DINNER' },
      meal_date: { kind: 'VALUE', value: '2026-08-11' },
      scope: { kind: 'VALUE', value: 'MANY' },
      recurring: { kind: 'VALUE', value: true },
    });

    expect(run.step.kind).toBe('SUMMARY');
    expect(run.asked[0]).toBe('health_impact');
    expect(run.asked.length).toBeLessThanOrEqual(6);
  });
});

describe('security (§14 — a live threat is critical)', () => {
  it('asks whether it is happening now before anything else', () => {
    const { schema, state } = start('there is a stranger in the hostel corridor');
    expect(schema.key).toBe('SECURITY');

    const step = nextStep(schema, state);
    expect(step.kind).toBe('QUESTION');
    if (step.kind === 'QUESTION') expect(step.slot.key).toBe('happening_now');
  });

  it('never asks "is it happening now" for a passive report', () => {
    const schema = getCategory('SECURITY')!;
    let state = emptyDraft('the CCTV camera at the gate is not working');
    state = applyAnswer(schema, state, 'problem_type', { kind: 'VALUE', value: 'CCTV' });

    const run = transcript(schema, state, {
      location: { kind: 'VALUE', value: 'loc-hostel-a' },
      scope: { kind: 'VALUE', value: 'MANY' },
      duration: { kind: 'VALUE', value: 'MULTI_DAY' },
    });

    expect(run.asked).not.toContain('happening_now');
    expect(run.step.kind).toBe('SUMMARY');
  });
});

describe('classroom and transport keep to their own conversations (§8)', () => {
  it('classroom asks the room, then whether teaching is affected', () => {
    const schema = getCategory('CLASSROOM')!;
    let state = emptyDraft('the projector is not working');
    state = applyAnswer(schema, state, 'problem_type', { kind: 'VALUE', value: 'PROJECTOR' });

    const run = transcript(schema, state, {
      location: { kind: 'VALUE', value: 'loc-cse' },
      impact: { kind: 'VALUE', value: 'CLASS' },
      scope: { kind: 'VALUE', value: 'ONLY_ME' },
      duration: { kind: 'VALUE', value: 'TODAY' },
    });

    expect(run.asked.slice(0, 2)).toEqual(['location', 'impact']);
    expect(run.step.kind).toBe('SUMMARY');
  });

  it('transport asks route and time, which no other category does', () => {
    const { schema, state } = start('the bus for my route never arrived at the Bus Bay');
    expect(schema.key).toBe('TRANSPORT');

    const run = transcript(schema, state, {
      problem_type: { kind: 'VALUE', value: 'NOT_ARRIVED' },
      impact: { kind: 'VALUE', value: 'CLASS' },
      route: { kind: 'VALUE', value: 'Route 4' },
      scheduled_time: { kind: 'VALUE', value: '8:15 am' },
      location: { kind: 'VALUE', value: 'loc-cse' },
      scope: { kind: 'VALUE', value: 'MANY' },
    });

    expect(run.asked).toContain('route');
    expect(run.step.kind).toBe('SUMMARY');
  });
});

describe('the no-key path still completes every category', () => {
  it('reaches a summary for all 13 categories using keyword extraction only', () => {
    for (const schema of [
      'NETWORK',
      'ELECTRICAL',
      'CLASSROOM',
      'HOSTEL',
      'HOSTEL_FOOD',
      'WATER',
      'SANITATION',
      'FURNITURE',
      'SECURITY',
      'TRANSPORT',
      'CANTEEN',
      'LIBRARY',
      'LAB_OTHER',
    ].map((k) => getCategory(k)!)) {
      // Answer every question with the first option / "not sure" — the worst-case
      // student, who still must be able to finish (§10).
      const answers: Record<string, AnswerInput> = {};
      for (const slot of schema.slots) {
        answers[slot.key] = slot.options
          ? { kind: 'VALUE', value: slot.type === 'multi' ? [slot.options[0].value] : slot.options[0].value }
          : { kind: 'UNSURE' };
      }

      const run = transcript(schema, emptyDraft('something is wrong'), answers, 20);
      expect(run.step.kind, schema.key).toBe('SUMMARY');

      const priority = assessPriority({
        classification: classify(schema, run.state.slots, null),
        safetyShortCircuit: hasSafetyShortCircuit(schema, run.state.slots),
      });
      expect(priority.reasons.length, schema.key).toBeGreaterThan(0);
    }
  });
});
