import { describe, expect, it } from 'vitest';
import {
  ALL_CATEGORY_KEYS,
  CATEGORY_LABELS,
  CATEGORY_SCHEMAS,
  getCategory,
} from '@/lib/engine/schemas';
import { DURATION_LEVELS, IMPACT_LEVELS, SCOPE_LEVELS } from '@/lib/engine/classify';
import { CATEGORY_BASE, HAZARD_WEIGHT } from '@/lib/engine/priority';
import { evaluateCondition } from '@/lib/engine/condition';
import { extractCategory, hintMatches, NEGATORS, normalize } from '@/lib/engine/extract/rules';
import { CATEGORY_CONFIDENCE_THRESHOLD, extractFromText } from '@/lib/engine/extract';

/**
 * Invariants rather than snapshots: these are the rules a new category schema has
 * to satisfy for the engine, the rubric and the extractor to work on it without
 * anyone remembering to wire something up.
 */

const SIGNAL_VOCABULARY: Record<string, string[]> = {
  SCOPE: SCOPE_LEVELS,
  IMPACT: IMPACT_LEVELS,
  DURATION: DURATION_LEVELS,
};

describe('category coverage', () => {
  it('has a slot schema for every category the spec names', () => {
    expect(CATEGORY_SCHEMAS.map((c) => c.key).sort()).toEqual([...ALL_CATEGORY_KEYS].sort());
  });

  it('agrees with the shared label table', () => {
    for (const schema of CATEGORY_SCHEMAS) {
      expect(schema.label, schema.key).toBe(CATEGORY_LABELS[schema.key as never]);
    }
  });

  it('never registers a category twice', () => {
    const keys = CATEGORY_SCHEMAS.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('every schema', () => {
  for (const schema of CATEGORY_SCHEMAS) {
    describe(schema.key, () => {
      it('declares a subcategory slot that exists and is an enum with options', () => {
        expect(schema.subcategorySlot).toBeTruthy();
        const slot = schema.slots.find((s) => s.key === schema.subcategorySlot);
        expect(slot, `${schema.key}.${schema.subcategorySlot}`).toBeTruthy();
        expect(slot!.type).toBe('enum');
        expect(slot!.options?.length ?? 0).toBeGreaterThan(1);
        expect(slot!.importance).toBe('REQUIRED');
      });

      it('asks for a location and for enough to prioritise on', () => {
        expect(schema.slots.some((s) => s.type === 'location')).toBe(true);
        // A category with no shared signal at all could only ever score its base.
        expect(schema.slots.some((s) => s.signal)).toBe(true);
      });

      it('uses unique slot keys and unique option values', () => {
        const keys = schema.slots.map((s) => s.key);
        expect(new Set(keys).size, `${schema.key} slot keys`).toBe(keys.length);

        for (const slot of schema.slots) {
          const values = (slot.options ?? []).map((o) => o.value);
          expect(new Set(values).size, `${schema.key}.${slot.key} options`).toBe(values.length);
        }
      });

      it('keeps signal slots inside the canonical vocabulary', () => {
        for (const slot of schema.slots) {
          const allowed = slot.signal ? SIGNAL_VOCABULARY[slot.signal] : undefined;
          if (!allowed) continue;
          for (const option of slot.options ?? []) {
            expect(allowed, `${schema.key}.${slot.key} = ${option.value}`).toContain(option.value);
          }
        }
      });

      it('only marks hazards the rubric can weigh', () => {
        for (const slot of schema.slots) {
          for (const option of slot.options ?? []) {
            if (!option.hazard) continue;
            expect(HAZARD_WEIGHT[option.hazard], `${schema.key}.${slot.key}`).toBeGreaterThan(0);
          }
        }
      });

      it('references only real slots in askIf conditions', () => {
        const keys = new Set(schema.slots.map((s) => s.key));
        const walk = (condition: unknown): void => {
          if (!condition || typeof condition !== 'object') return;
          const c = condition as Record<string, unknown>;
          if (typeof c.slot === 'string') expect(keys, schema.key).toContain(c.slot);
          for (const nested of [c.and, c.or, c.not].flat()) walk(nested);
        };
        for (const slot of schema.slots) walk(slot.askIf);
      });

      it('gives every REQUIRED slot a way past "I\'m not sure" (§10)', () => {
        for (const slot of schema.slots) {
          if (slot.importance !== 'REQUIRED') continue;
          expect(
            Object.prototype.hasOwnProperty.call(slot, 'unsureDefault'),
            `${schema.key}.${slot.key} needs an unsureDefault`,
          ).toBe(true);
        }
      });

      it('defaults an unsure REQUIRED slot to one of its own options', () => {
        for (const slot of schema.slots) {
          if (slot.importance !== 'REQUIRED' || !slot.options) continue;
          if (slot.unsureDefault == null) continue;
          const values = slot.options.map((o) => o.value);
          expect(values, `${schema.key}.${slot.key}`).toContain(slot.unsureDefault);
        }
      });

      it('only declares criticalValues on safety-critical slots, and only real ones', () => {
        for (const slot of schema.slots) {
          if (!slot.criticalValues) continue;
          expect(slot.safetyCritical, `${schema.key}.${slot.key}`).toBe(true);
          if (!slot.options) continue;
          const values = slot.options.map((o) => o.value);
          for (const critical of slot.criticalValues) {
            expect(values, `${schema.key}.${slot.key}`).toContain(critical);
          }
        }
      });

      it('marks every critical option as a hazard so the rubric sees it too', () => {
        for (const slot of schema.slots) {
          if (!slot.criticalValues || !slot.options) continue;
          for (const critical of slot.criticalValues) {
            const option = slot.options.find((o) => o.value === critical);
            expect(option?.hazard, `${schema.key}.${slot.key} = ${String(critical)}`).toBeTruthy();
          }
        }
      });

      it('has hints that survive negation handling', () => {
        // Regression guard from Layer 3: "nothing sparking or smoking" must not
        // fill a safety slot. Any new hint list inherits the same rule.
        for (const slot of schema.slots) {
          for (const option of slot.options ?? []) {
            for (const hint of option.hints ?? []) {
              const negated = normalize(`there is nothing ${hint} here`);
              const plain = normalize(`there is ${hint} here`);
              // A hint that is itself negative ("no internet") is exempt by design.
              const startsNegative = NEGATORS.has(normalize(hint).trim().split(' ')[0]);
              expect(hintMatches(plain, hint), `${schema.key}.${slot.key}: ${hint}`).toBe(true);
              if (!startsNegative) {
                expect(hintMatches(negated, hint), `${schema.key}.${slot.key}: ${hint}`).toBe(false);
              }
            }
          }
        }
      });
    });
  }
});

describe('rubric wiring', () => {
  it('assigns a base to every registered category', () => {
    for (const schema of CATEGORY_SCHEMAS) {
      expect(CATEGORY_BASE[schema.key], schema.key).toBeGreaterThan(0);
    }
  });

  it('never leaves a conditional slot permanently unreachable', () => {
    // A slot whose askIf can never pass would be dead schema. Approximated by
    // checking the condition passes for at least one single-value assignment of
    // the slot it depends on.
    for (const schema of CATEGORY_SCHEMAS) {
      for (const slot of schema.slots) {
        const condition = slot.askIf;
        if (!condition || !('slot' in condition)) continue;
        const dependency = schema.slots.find((s) => s.key === condition.slot);
        expect(dependency, `${schema.key}.${slot.key}`).toBeTruthy();

        const candidates: unknown[] = dependency!.options
          ? dependency!.options.map((o) => o.value)
          : [true, false];
        const reachable = candidates.some((value) =>
          evaluateCondition(condition, {
            [dependency!.key]: { value, state: 'FILLED', source: 'ANSWERED', confidence: 1 },
          }),
        );
        expect(reachable, `${schema.key}.${slot.key} can never be asked`).toBe(true);
      }
    }
  });
});

describe('category classification reaches the new categories', () => {
  it('routes a plain sentence to the right category by keywords alone', () => {
    const cases: [string, string][] = [
      ['the mess food was stale at dinner', 'HOSTEL_FOOD'],
      ['a pipe has burst and water is flooding the corridor', 'WATER'],
      ['the projector in CSE 101 is not working', 'CLASSROOM'],
      ['there is a stranger in the hostel corridor', 'SECURITY'],
      ['the bus for route 4 never arrived', 'TRANSPORT'],
      ['the washroom has not been cleaned for two days', 'SANITATION'],
      ['my hostel room cupboard door is broken', 'HOSTEL'],
      ['the library reading room has no seats', 'LIBRARY'],
      ['the oscilloscope in the electronics lab is broken', 'LAB_OTHER'],
      ['the canteen overcharged me for a sandwich', 'CANTEEN'],
    ];

    for (const [text, expected] of cases) {
      const guess = extractCategory(text);
      expect(guess?.categoryKey, text).toBe(expected);
      expect(guess!.confidence, text).toBeGreaterThanOrEqual(CATEGORY_CONFIDENCE_THRESHOLD);
      expect(getCategory(guess!.categoryKey)).toBeTruthy();
    }
  });

  it('asks instead of guessing when two categories fit equally well', () => {
    // "the fan in my hostel room is not working" is honestly both ELECTRICAL and
    // HOSTEL. With 13 categories some overlap is unavoidable, so the extractor
    // caps its confidence and the student picks (§9) rather than it guessing.
    const ambiguous = extractFromText('the fan in my hostel room is not working', null);

    expect(ambiguous.categoryKey).toBeNull();
    expect(ambiguous.categoryConfidence).toBeLessThan(CATEGORY_CONFIDENCE_THRESHOLD);
  });
});
