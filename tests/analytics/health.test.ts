import { describe, expect, it } from 'vitest';
import {
  CRITICAL_PENALTY_CAP,
  healthScore,
  MEANINGFUL_VOLUME,
  RECURRING_PENALTY_CAP,
  REOPEN_WEIGHT,
  SATISFACTION_WEIGHT,
  SLA_WEIGHT,
  type HealthInputs,
} from '@/lib/analytics/health';

function inputs(over: Partial<HealthInputs> = {}): HealthInputs {
  return {
    openCritical: 0,
    slaBreachRate: 0,
    reopenRate: 0,
    recurringAct: 0,
    recurringWatch: 0,
    satisfactionAverage: null,
    volume: 100,
    ...over,
  };
}

describe('healthScore', () => {
  it('scores a campus with nothing wrong and nothing rated at 100', () => {
    const result = healthScore(inputs());
    expect(result.score).toBe(100);
    expect(result.band).toBe('GOOD');
  });

  it('applies §34s formula term by term', () => {
    const result = healthScore(
      inputs({
        openCritical: 2, // −8
        slaBreachRate: 0.2, // −5
        reopenRate: 0.2, // −3
        recurringAct: 1, // −3
        recurringWatch: 2, // −2
        satisfactionAverage: 4, // +7.5
      }),
    );
    // 100 − 8 − 5 − 3 − 5 + 7.5 = 86.5 → 87
    expect(result.score).toBe(87);
    expect(result.band).toBe('GOOD');
  });

  it('weights each term the way §34 says', () => {
    expect(healthScore(inputs({ slaBreachRate: 1 })).score).toBe(100 - SLA_WEIGHT);
    expect(healthScore(inputs({ reopenRate: 1 })).score).toBe(100 - REOPEN_WEIGHT);
    expect(healthScore(inputs({ satisfactionAverage: 5 })).score).toBe(100);
    expect(healthScore(inputs({ satisfactionAverage: 1, slaBreachRate: 0.4 })).score).toBe(
      100 - 0.4 * SLA_WEIGHT,
    );
    // Five stars is worth the whole bonus, which shows against a penalty.
    expect(healthScore(inputs({ satisfactionAverage: 5, slaBreachRate: 0.4 })).score).toBe(
      100 - 0.4 * SLA_WEIGHT + SATISFACTION_WEIGHT,
    );
  });

  it('caps the penalties so one bad month cannot bottom out the score', () => {
    const manyCriticals = healthScore(inputs({ openCritical: 50 }));
    expect(manyCriticals.score).toBe(100 - CRITICAL_PENALTY_CAP);

    const manySignals = healthScore(inputs({ recurringAct: 20, recurringWatch: 20 }));
    expect(manySignals.score).toBe(100 - RECURRING_PENALTY_CAP);
  });

  it('clamps to 0..100 whatever the inputs claim', () => {
    const dire = healthScore(
      inputs({ openCritical: 99, slaBreachRate: 1, reopenRate: 1, recurringAct: 99 }),
    );
    expect(dire.score).toBe(100 - CRITICAL_PENALTY_CAP - SLA_WEIGHT - REOPEN_WEIGHT - RECURRING_PENALTY_CAP);
    expect(dire.score).toBeGreaterThanOrEqual(0);

    // Rates outside 0..1 are treated as broken input, not as extra penalty.
    expect(healthScore(inputs({ slaBreachRate: 4 })).score).toBe(100 - SLA_WEIGHT);
    expect(healthScore(inputs({ slaBreachRate: Number.NaN })).score).toBe(100);
    expect(healthScore(inputs({ reopenRate: -3 })).score).toBe(100);
  });

  // No feedback is not bad feedback — a quiet month must not be scored as an
  // unhappy one.
  it('gives no bonus either way when nothing has been rated', () => {
    const unrated = healthScore(inputs({ satisfactionAverage: null }));
    const term = unrated.terms.find((t) => t.label === 'Student satisfaction')!;
    expect(term.points).toBe(0);
    expect(term.detail).toMatch(/Nothing rated yet/);
  });

  // §14's discipline, applied to §34: a number nobody can argue with is a number
  // nobody can act on.
  it('never returns a bare number — every term carries its points and its evidence', () => {
    const result = healthScore(inputs({ openCritical: 3, slaBreachRate: 0.36, reopenRate: 0.1 }));
    expect(result.terms).toHaveLength(5);
    for (const term of result.terms) {
      expect(term.label).toBeTruthy();
      expect(term.detail).toBeTruthy();
      expect(Number.isFinite(term.points)).toBe(true);
    }
    expect(result.terms.find((t) => t.label === 'SLA compliance')!.detail).toContain('36%');
    expect(result.terms.find((t) => t.label === 'Open critical complaints')!.detail).toContain('3');
  });

  it('bands the score for the badge', () => {
    expect(healthScore(inputs()).band).toBe('GOOD');
    expect(healthScore(inputs({ slaBreachRate: 1 })).band).toBe('FAIR');
    expect(healthScore(inputs({ slaBreachRate: 1, reopenRate: 1, openCritical: 5 })).band).toBe('POOR');
  });

  it('flags a score computed from too little history', () => {
    expect(healthScore(inputs({ volume: MEANINGFUL_VOLUME - 1 })).meaningful).toBe(false);
    expect(healthScore(inputs({ volume: MEANINGFUL_VOLUME })).meaningful).toBe(true);
  });
});
