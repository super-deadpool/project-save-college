import { describe, expect, it } from 'vitest';
import {
  classify,
  collectHazards,
  computeSignature,
  scopeBucketOf,
  type LocationFacts,
} from '@/lib/engine/classify';
import { electricalSchema, getCategory, networkSchema } from '@/lib/engine/schemas';
import type { SlotValues } from '@/lib/engine/types';

function filled(values: Record<string, unknown>): SlotValues {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      { value, state: 'FILLED' as const, source: 'ANSWERED' as const, confidence: 1 },
    ]),
  );
}

const CSE_BLOCK: LocationFacts = {
  id: 'loc-cse',
  name: 'CSE Block',
  type: 'ACADEMIC',
  criticality: 0.7,
};

describe('classify — §13 normalization', () => {
  it('flattens answers into the facts the rest of the system reasons about', () => {
    const c = classify(
      networkSchema,
      filled({
        problem_type: 'NO_CONNECTION',
        location: 'loc-cse',
        scope: 'BUILDING',
        duration: 'ONE_DAY',
        impact: 'EXAM',
      }),
      CSE_BLOCK,
    );

    expect(c).toMatchObject({
      categoryKey: 'NETWORK',
      subcategoryKey: 'NO_CONNECTION',
      subcategoryLabel: 'No connection at all',
      scope: 'BUILDING',
      scopeBucket: 'WIDESPREAD',
      duration: 'ONE_DAY',
      impact: 'EXAM',
      hazards: [],
      personAtRisk: null,
      locationType: 'ACADEMIC',
      locationCriticality: 0.7,
    });
  });

  it('reports UNKNOWN rather than guessing when a signal was never answered', () => {
    const c = classify(networkSchema, filled({ problem_type: 'SLOW' }), null);

    expect(c.scope).toBe('UNKNOWN');
    expect(c.impact).toBe('UNKNOWN');
    expect(c.duration).toBe('UNKNOWN');
    expect(c.scopeBucket).toBe('UNKNOWN');
    expect(c.locationCriticality).toBeNull();
  });

  it('ignores a skipped signal but keeps a defaulted safety answer', () => {
    const slots: SlotValues = {
      ...filled({ problem_type: 'EXPOSED_WIRING', safety_hazard: ['EXPOSED_WIRE'] }),
      scope: { value: null, state: 'SKIPPED', source: 'ANSWERED', confidence: 1 },
      // "I'm not sure" on "is anyone at risk" defaults to true by design (§10).
      person_at_risk: { value: true, state: 'UNKNOWN', source: 'DEFAULTED', confidence: 0.3 },
    };

    const c = classify(electricalSchema, slots, null);

    expect(c.scope).toBe('UNKNOWN');
    expect(c.personAtRisk).toBe(true);
    expect(c.hazards).toEqual(['EXPOSED_WIRE']);
  });

  it('reads hazards from option markers, worst first, without duplicates', () => {
    const hazards = collectHazards(
      electricalSchema,
      filled({
        safety_hazard: ['EXPOSED_WIRE', 'SMOKE', 'SPARKING'],
        problem_type: 'EXPOSED_WIRING',
      }),
    );

    // EXPOSED_WIRE is marked on two different slots but appears once.
    expect(hazards).toEqual(['SMOKE', 'SPARKING', 'EXPOSED_WIRE']);
  });

  it('drops values outside the canonical vocabulary instead of passing them through', () => {
    const c = classify(networkSchema, filled({ problem_type: 'SLOW', scope: 'HALF_THE_PLANET' }), null);
    expect(c.scope).toBe('UNKNOWN');
  });

  it('scores confidence on answered slots and names what is unresolved', () => {
    const c = classify(
      networkSchema,
      filled({ problem_type: 'NO_CONNECTION', location: 'loc-cse', scope: 'MANY' }),
      CSE_BLOCK,
    );

    // 3 of 5 non-optional slots answered.
    expect(c.confidence).toBeCloseTo(0.6, 2);
    expect(c.unresolved).toEqual(['duration', 'impact']);
  });
});

describe('signature — the key Layer 5 dedup will group on', () => {
  it('collapses different wordings of the same widespread issue', () => {
    const wordings = ['MANY', 'BUILDING', 'CAMPUS'];
    const signatures = new Set(
      wordings.map(
        (scope) =>
          classify(
            networkSchema,
            filled({ problem_type: 'NO_CONNECTION', location: 'loc-cse', scope }),
            CSE_BLOCK,
          ).signature,
      ),
    );

    expect(signatures.size).toBe(1);
    expect([...signatures][0]).toBe('NETWORK|NO_CONNECTION|loc-cse|WIDESPREAD');
  });

  it('separates an isolated report from a widespread one', () => {
    const isolated = classify(
      networkSchema,
      filled({ problem_type: 'NO_CONNECTION', location: 'loc-cse', scope: 'ONLY_ME' }),
      CSE_BLOCK,
    ).signature;

    expect(isolated).toBe('NETWORK|NO_CONNECTION|loc-cse|ISOLATED');
  });

  it('is stable and location-scoped', () => {
    expect(scopeBucketOf('FEW')).toBe('ISOLATED');
    expect(
      computeSignature({ categoryKey: 'WATER', subcategoryKey: 'LEAK', scopeBucket: 'ISOLATED' }),
    ).toBe('WATER|LEAK|NOLOC|ISOLATED');
  });
});

describe('classify — every category', () => {
  it('normalizes each of the 13 categories without special-casing', () => {
    for (const key of [
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
    ]) {
      const schema = getCategory(key)!;
      const problem = schema.slots.find((s) => s.key === schema.subcategorySlot)!;
      const c = classify(schema, filled({ [problem.key]: problem.options![0].value }), CSE_BLOCK);

      expect(c.categoryKey).toBe(key);
      expect(c.subcategoryKey).toBe(problem.options![0].value);
      expect(c.signature.startsWith(`${key}|`)).toBe(true);
    }
  });
});
