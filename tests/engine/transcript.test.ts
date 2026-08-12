import { describe, expect, it } from 'vitest';
import { getCategory } from '@/lib/engine/schemas';
import { extractFromText } from '@/lib/engine/extract';
import {
  applyAnswer,
  emptyDraft,
  mergeExtracted,
  nextStep,
  type AnswerInput,
} from '@/lib/engine/draft';
import type { CategorySchema, DraftState } from '@/lib/engine/types';

const LOCATIONS = [
  { id: 'loc-cse', name: 'CSE Block' },
  { id: 'loc-hostel-a', name: 'Boys Hostel A' },
  { id: 'loc-lab', name: 'CSE Programming Lab 1' },
];

function start(text: string): { schema: CategorySchema; state: DraftState } {
  const extraction = extractFromText(text, null, { locations: LOCATIONS });
  const schema = getCategory(extraction.categoryKey);
  if (!schema) throw new Error(`No category matched: ${text}`);
  return { schema, state: mergeExtracted(schema, emptyDraft(text), extraction.slots) };
}

/** Walk the conversation, answering scripted values, and record what was asked. */
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
    const answer = answers[step.slot.key] ?? { kind: 'SKIP' as const };
    state = applyAnswer(schema, state, step.slot.key, answer);
  }
  throw new Error('Conversation did not terminate');
}

describe('category + slot extraction', () => {
  it('classifies "wifi is down" as NETWORK and pre-fills the problem', () => {
    const { schema, state } = start('The wifi is down');
    expect(schema.key).toBe('NETWORK');
    expect(state.slots.problem_type).toMatchObject({
      value: 'NO_CONNECTION',
      source: 'EXTRACTED',
    });
  });

  it('resolves a location only when the full name is present', () => {
    const vague = extractFromText('no power in the hostel', null, { locations: LOCATIONS });
    expect(vague.slots.location).toBeUndefined();

    const precise = extractFromText('no power in Boys Hostel A', null, { locations: LOCATIONS });
    expect(precise.slots.location).toMatchObject({ value: 'loc-hostel-a' });
  });
});

describe('question sequencing', () => {
  it('"wifi is down" asks location → scope → duration → impact, then stops', () => {
    const { schema, state } = start('The wifi is down');
    const run = transcript(schema, state, {
      location: { kind: 'VALUE', value: 'loc-cse' },
      scope: { kind: 'VALUE', value: 'MANY' },
      duration: { kind: 'VALUE', value: 'TODAY' },
      impact: { kind: 'VALUE', value: 'CLASS' },
    });

    expect(run.asked).toEqual(['location', 'scope', 'duration', 'impact']);
    expect(run.step.kind).toBe('SUMMARY');
  });

  it('"exposed wiring in the hostel" asks the at-risk question first', () => {
    const { schema, state } = start('There is exposed wiring near the hostel entrance');
    expect(schema.key).toBe('ELECTRICAL');
    expect(state.slots.safety_hazard).toMatchObject({ value: ['EXPOSED_WIRE'] });

    const step = nextStep(schema, state);
    expect(step.kind).toBe('QUESTION');
    if (step.kind === 'QUESTION') expect(step.slot.key).toBe('person_at_risk');
  });

  it('stops immediately when a safety-critical answer indicates danger', () => {
    const schema = getCategory('ELECTRICAL')!;
    let state = emptyDraft('fan not working');
    state = applyAnswer(schema, state, 'safety_hazard', { kind: 'VALUE', value: ['SMOKE'] });

    const step = nextStep(schema, state);
    expect(step.kind).toBe('SUMMARY');
    if (step.kind === 'SUMMARY') {
      expect(step.completeness.safetyShortCircuit).toBe(true);
      expect(step.completeness.reason).toBe('SAFETY_SHORT_CIRCUIT');
    }
  });

  it('skips the at-risk question when no hazard is present', () => {
    const schema = getCategory('ELECTRICAL')!;
    let state = emptyDraft('fan not working in my room');
    state = applyAnswer(schema, state, 'safety_hazard', { kind: 'VALUE', value: ['NONE'] });

    const run = transcript(schema, state, {
      problem_type: { kind: 'VALUE', value: 'FAN_NOT_WORKING' },
      location: { kind: 'VALUE', value: 'loc-hostel-a' },
      scope: { kind: 'VALUE', value: 'ONLY_ME' },
      duration: { kind: 'VALUE', value: 'TODAY' },
      impact: { kind: 'VALUE', value: 'NONE' },
    });

    expect(run.asked).not.toContain('person_at_risk');
    // location outranks problem_type on infoGain; both come before the
    // RECOMMENDED slots.
    expect(run.asked.slice(0, 2)).toEqual(['location', 'problem_type']);
    expect(run.step.kind).toBe('SUMMARY');
  });
});

describe('"I\'m not sure" and skip (§10)', () => {
  it('never blocks on an unsure REQUIRED answer — it defaults and moves on', () => {
    const { schema, state } = start('The wifi is down');
    const run = transcript(schema, state, {
      location: { kind: 'UNSURE' },
      scope: { kind: 'UNSURE' },
      duration: { kind: 'SKIP' },
      impact: { kind: 'VALUE', value: 'EXAM' },
    });

    expect(run.step.kind).toBe('SUMMARY');
    expect(run.state.slots.location.state).toBe('UNKNOWN');
    expect(run.state.slots.duration.state).toBe('SKIPPED');
  });
});
