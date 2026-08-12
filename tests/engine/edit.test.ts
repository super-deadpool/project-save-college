import { describe, expect, it } from 'vitest';
import { getCategory } from '@/lib/engine/schemas';
import { applyAnswer, clearAnswer, emptyDraft, nextStep } from '@/lib/engine/draft';

const electrical = getCategory('ELECTRICAL')!;

describe('editing a previous answer (§12)', () => {
  it('invalidates downstream answers whose askIf no longer holds', () => {
    let state = emptyDraft('sparking socket');
    state = applyAnswer(electrical, state, 'safety_hazard', { kind: 'VALUE', value: ['SPARKING'] });
    state = applyAnswer(electrical, state, 'person_at_risk', { kind: 'VALUE', value: false });
    expect(state.slots.person_at_risk).toBeDefined();

    // The student corrects themselves: no hazard after all.
    state = applyAnswer(electrical, state, 'safety_hazard', { kind: 'VALUE', value: ['NONE'] });

    expect(state.slots.person_at_risk).toBeUndefined();
    expect(state.askedSlots).not.toContain('person_at_risk');
  });

  it('re-asks a cleared slot', () => {
    let state = emptyDraft('no power');
    state = applyAnswer(electrical, state, 'safety_hazard', { kind: 'VALUE', value: ['NONE'] });
    state = applyAnswer(electrical, state, 'location', { kind: 'VALUE', value: 'loc-1' });
    state = applyAnswer(electrical, state, 'problem_type', { kind: 'VALUE', value: 'NO_POWER' });

    state = clearAnswer(electrical, state, 'location');
    const step = nextStep(electrical, state);

    expect(step.kind).toBe('QUESTION');
    if (step.kind === 'QUESTION') expect(step.slot.key).toBe('location');
  });

  it('brings the at-risk question back when a hazard is added later', () => {
    let state = emptyDraft('light not working');
    state = applyAnswer(electrical, state, 'safety_hazard', { kind: 'VALUE', value: ['NONE'] });
    state = applyAnswer(electrical, state, 'location', { kind: 'VALUE', value: 'loc-1' });
    state = applyAnswer(electrical, state, 'problem_type', {
      kind: 'VALUE',
      value: 'LIGHT_NOT_WORKING',
    });

    state = applyAnswer(electrical, state, 'safety_hazard', {
      kind: 'VALUE',
      value: ['EXPOSED_WIRE'],
    });

    const step = nextStep(electrical, state);
    expect(step.kind).toBe('QUESTION');
    if (step.kind === 'QUESTION') expect(step.slot.key).toBe('person_at_risk');
  });
});
