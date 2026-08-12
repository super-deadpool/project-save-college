import { describe, expect, it } from 'vitest';
import { evaluateCondition } from '@/lib/engine/condition';
import type { SlotValues } from '@/lib/engine/types';

const filled = (value: unknown): SlotValues['x'] => ({
  value,
  state: 'FILLED',
  source: 'ANSWERED',
  confidence: 1,
});

describe('evaluateCondition', () => {
  const slots: SlotValues = {
    hazard: filled(['EXPOSED_WIRE', 'SPARKING']),
    problem: filled('NO_POWER'),
    unsure: { value: null, state: 'UNKNOWN', source: 'ANSWERED', confidence: 0.3 },
  };

  it('treats an absent condition as "always ask"', () => {
    expect(evaluateCondition(undefined, slots)).toBe(true);
  });

  it('matches eq/ne on scalars', () => {
    expect(evaluateCondition({ slot: 'problem', op: 'eq', value: 'NO_POWER' }, slots)).toBe(true);
    expect(evaluateCondition({ slot: 'problem', op: 'ne', value: 'NO_POWER' }, slots)).toBe(false);
  });

  it('treats "in" against a multi-select as contains', () => {
    expect(
      evaluateCondition({ slot: 'hazard', op: 'in', value: ['SMOKE', 'SPARKING'] }, slots),
    ).toBe(true);
    expect(evaluateCondition({ slot: 'hazard', op: 'in', value: ['SMOKE'] }, slots)).toBe(false);
  });

  it('does not count UNKNOWN or missing answers as filled', () => {
    expect(evaluateCondition({ slot: 'unsure', op: 'filled' }, slots)).toBe(false);
    expect(evaluateCondition({ slot: 'missing', op: 'unfilled' }, slots)).toBe(true);
  });

  it('composes and/or/not', () => {
    expect(
      evaluateCondition(
        {
          and: [
            { slot: 'problem', op: 'eq', value: 'NO_POWER' },
            { not: { slot: 'hazard', op: 'in', value: ['SMOKE'] } },
          ],
        },
        slots,
      ),
    ).toBe(true);

    expect(
      evaluateCondition(
        { or: [{ slot: 'problem', op: 'eq', value: 'X' }, { slot: 'hazard', op: 'filled' }] },
        slots,
      ),
    ).toBe(true);
  });
});
