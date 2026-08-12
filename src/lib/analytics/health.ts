import { satisfactionFraction } from '@/lib/feedback/satisfaction';

/**
 * §34 — the campus health score.
 *
 *     health = 100 − openCriticalPenalty − slaBreachRate*25 − reopenRate*15
 *                  − recurringIssuePenalty + satisfactionBonus     → clamp 0..100
 *
 * Pure (CLAUDE.md §5), and it returns its terms rather than a bare number for the
 * same reason a priority band never travels without its reasons (§14): "78/100"
 * is an assertion, and "78 = 100 − 12 for four open criticals − 9 for a 36% SLA
 * breach rate + 8 for satisfaction" is an argument someone can check and act on.
 */

export interface HealthInputs {
  /** Complaints at CRITICAL that are still not settled. */
  openCritical: number;
  /** Fraction of complaints with a promise that broke it, 0..1. */
  slaBreachRate: number;
  /** Fraction of finished complaints that had to be reopened, 0..1. */
  reopenRate: number;
  /** §27's signals: the sustained ones weigh more than the ones merely watched. */
  recurringAct: number;
  recurringWatch: number;
  /** Mean §24 rating, 1..5, or null when nobody has rated anything. */
  satisfactionAverage: number | null;
  /** Complaints in the window, for the "not enough data" case. */
  volume: number;
}

export interface HealthTerm {
  label: string;
  /** Signed points: negative is a penalty, positive is the satisfaction bonus. */
  points: number;
  /** The measurement behind the points, in words. */
  detail: string;
}

export interface HealthScore {
  score: number;
  band: 'GOOD' | 'FAIR' | 'POOR';
  terms: HealthTerm[];
  /** False when there is too little history for the number to mean anything. */
  meaningful: boolean;
}

/** Weights, named so the formula reads like §34 rather than like arithmetic. */
export const SLA_WEIGHT = 25;
export const REOPEN_WEIGHT = 15;
export const SATISFACTION_WEIGHT = 10;
/** Per open critical complaint, capped — twenty of them is not a −100 campus. */
export const CRITICAL_PENALTY = 4;
export const CRITICAL_PENALTY_CAP = 20;
export const RECURRING_ACT_PENALTY = 3;
export const RECURRING_WATCH_PENALTY = 1;
export const RECURRING_PENALTY_CAP = 15;

/** Under this many complaints the rates are too jumpy to publish a score from. */
export const MEANINGFUL_VOLUME = 10;

export function healthScore(input: HealthInputs): HealthScore {
  const criticalPenalty = Math.min(CRITICAL_PENALTY_CAP, input.openCritical * CRITICAL_PENALTY);
  const slaPenalty = clamp01(input.slaBreachRate) * SLA_WEIGHT;
  const reopenPenalty = clamp01(input.reopenRate) * REOPEN_WEIGHT;
  const recurringPenalty = Math.min(
    RECURRING_PENALTY_CAP,
    input.recurringAct * RECURRING_ACT_PENALTY + input.recurringWatch * RECURRING_WATCH_PENALTY,
  );

  // No feedback is not bad feedback: an unrated campus simply earns no bonus
  // rather than being scored as if every student was unhappy.
  const fraction = satisfactionFraction(input.satisfactionAverage);
  const satisfactionBonus = fraction == null ? 0 : fraction * SATISFACTION_WEIGHT;

  const raw = 100 - criticalPenalty - slaPenalty - reopenPenalty - recurringPenalty + satisfactionBonus;
  const score = Math.round(Math.min(100, Math.max(0, raw)));

  const terms: HealthTerm[] = [
    {
      label: 'Open critical complaints',
      points: -criticalPenalty,
      detail:
        input.openCritical === 0
          ? 'None outstanding'
          : `${input.openCritical} unresolved at CRITICAL${criticalPenalty === CRITICAL_PENALTY_CAP ? ' (penalty capped)' : ''}`,
    },
    {
      label: 'SLA compliance',
      points: -round1(slaPenalty),
      detail: `${percent(input.slaBreachRate)} of complaints with a deadline missed it`,
    },
    {
      label: 'Reopened complaints',
      points: -round1(reopenPenalty),
      detail: `${percent(input.reopenRate)} of finished complaints came back`,
    },
    {
      label: 'Recurring issues',
      points: -recurringPenalty,
      detail:
        input.recurringAct + input.recurringWatch === 0
          ? 'No rising trends detected'
          : `${input.recurringAct} needing action, ${input.recurringWatch} to watch`,
    },
    {
      label: 'Student satisfaction',
      points: round1(satisfactionBonus),
      detail:
        input.satisfactionAverage == null
          ? 'Nothing rated yet — no bonus either way'
          : `${input.satisfactionAverage.toFixed(1)}/5 average`,
    },
  ];

  return {
    score,
    band: score >= 80 ? 'GOOD' : score >= 60 ? 'FAIR' : 'POOR',
    terms,
    meaningful: input.volume >= MEANINGFUL_VOLUME,
  };
}

export const HEALTH_BAND_LABEL: Record<HealthScore['band'], string> = {
  GOOD: 'Healthy',
  FAIR: 'Under strain',
  POOR: 'Needs attention',
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function percent(fraction: number): string {
  return `${Math.round(clamp01(fraction) * 100)}%`;
}
