import type { Priority } from '@/generated/prisma/enums';
import type { LocationType } from '@/generated/prisma/enums';
import type { Classification, DurationLevel, ImpactLevel, ScopeLevel } from './classify';
import type { Hazard } from './types';

/**
 * The priority rubric (plan.MD §4, spec §14). Deterministic and additive, and it
 * returns the *reasons* alongside the band — §14 requires the reason, so this
 * module never returns a bare priority.
 *
 *   score = categoryBase + hazard + scope + impact + duration
 *         + locationCriticality + recurrence
 *
 *   band  = ≥120 CRITICAL · ≥75 HIGH · ≥40 MEDIUM · else LOW
 *
 * Hard overrides jump straight to CRITICAL regardless of score: a fire does not
 * need to out-point a campus-wide outage.
 */

export const BANDS: { band: Priority; min: number }[] = [
  { band: 'CRITICAL', min: 120 },
  { band: 'HIGH', min: 75 },
  { band: 'MEDIUM', min: 40 },
  { band: 'LOW', min: 0 },
];

/**
 * Where a category starts before circumstances are considered. Safety-facing
 * categories start higher because their *floor* is more serious, not because
 * every report is urgent (spec §14 examples).
 */
export const CATEGORY_BASE: Record<string, number> = {
  SECURITY: 45,
  ELECTRICAL: 40,
  WATER: 35,
  HOSTEL_FOOD: 30,
  NETWORK: 25,
  CLASSROOM: 25,
  LAB_OTHER: 25,
  TRANSPORT: 25,
  HOSTEL: 20,
  SANITATION: 20,
  CANTEEN: 20,
  LIBRARY: 15,
  FURNITURE: 10,
};

export const DEFAULT_CATEGORY_BASE = 20;

/** Worst hazard only — smoke *and* a burning smell is one fire, not two. */
export const HAZARD_WEIGHT: Record<Hazard, number> = {
  FIRE: 80,
  GAS_LEAK: 75,
  SMOKE: 70,
  ELECTRIC_SHOCK: 70,
  CHEMICAL: 65,
  SPARKING: 60,
  MAJOR_LEAK: 60,
  SECURITY_THREAT: 60,
  BURNING_SMELL: 55,
  FLOODING: 55,
  STRUCTURAL: 50,
  EXPOSED_WIRE: 50,
  HARASSMENT: 45,
  // Below "broken classroom equipment" on its own, so a bench with a nail in it
  // needs scope or impact behind it to reach HIGH (§14 puts furniture lowest).
  INJURY: 30,
  FOOD_ILLNESS: 30,
  SEWAGE: 25,
};

/**
 * Hazards that are CRITICAL on their own (spec §14: fire, smoke, major leakage,
 * security threat). The rest score points and reach CRITICAL only in combination
 * — a bench with a nail in it is an injury risk, not a campus emergency.
 */
export const CRITICAL_HAZARDS: Hazard[] = [
  'FIRE',
  'SMOKE',
  'GAS_LEAK',
  'CHEMICAL',
  'ELECTRIC_SHOCK',
  'MAJOR_LEAK',
  'FLOODING',
  'SECURITY_THREAT',
];

export const PERSON_AT_RISK_WEIGHT = 40;

export const SCOPE_WEIGHT: Record<ScopeLevel, number> = {
  ONLY_ME: 0,
  FEW: 10,
  MANY: 25,
  BUILDING: 35,
  CAMPUS: 50,
  UNKNOWN: 0,
};

export const IMPACT_WEIGHT: Record<ImpactLevel, number> = {
  EXAM: 30,
  CLASS: 20,
  ASSIGNMENT: 10,
  NONE: 0,
  UNKNOWN: 0,
};

export const DURATION_WEIGHT: Record<DurationLevel, number> = {
  MULTI_DAY: 15,
  ONE_DAY: 10,
  TODAY: 5,
  JUST_NOW: 0,
  UNKNOWN: 0,
};

/** Criticality is a seeded 0..1 per location; 15 points at the top of the range. */
export const LOCATION_WEIGHT_MAX = 15;
/** An unidentified location scores the campus average rather than nothing. */
export const ASSUMED_CRITICALITY = 0.5;

export const RECURRENCE_THRESHOLD = 3;
export const RECURRENCE_WEIGHT = 10;
/** A student saying "this keeps happening" is weaker evidence than the history. */
export const REPORTED_RECURRENCE_WEIGHT = 5;

export type ReasonCode =
  | 'CATEGORY'
  | 'HAZARD'
  | 'PERSON_AT_RISK'
  | 'SCOPE'
  | 'IMPACT'
  | 'DURATION'
  | 'LOCATION'
  | 'RECURRENCE'
  | 'OVERRIDE';

export interface PriorityReason {
  code: ReasonCode;
  /** A sentence, as §14 renders it: "Multiple students are affected." */
  label: string;
  points: number;
  /** The evidence behind the sentence, for the staff-facing breakdown. */
  detail?: string;
}

export interface PriorityInput {
  classification: Classification;
  /**
   * True when a `safetyCritical` slot was answered with one of its
   * `criticalValues` — the same signal that stops the conversation (plan.MD §3).
   * Passing it in keeps the schemas the single source of truth for live danger,
   * so a short-circuited conversation can never submit as non-critical.
   */
  safetyShortCircuit?: boolean;
  /** Complaints with this signature in the recurrence window (Layer 5 dedup reuses it). */
  recurrenceCount?: number;
}

export interface PriorityResult {
  band: Priority;
  score: number;
  /** Every contributing term, worst first. Persisted for the audit trail. */
  reasons: PriorityReason[];
  /** Non-empty when a hard override decided the band regardless of score. */
  overrides: string[];
}

export function bandForScore(score: number): Priority {
  return BANDS.find((b) => score >= b.min)?.band ?? 'LOW';
}

const HAZARD_SENTENCE: Record<Hazard, string> = {
  FIRE: 'A fire was reported.',
  SMOKE: 'Smoke was reported.',
  GAS_LEAK: 'A gas leak was reported.',
  CHEMICAL: 'A chemical spill or fumes were reported.',
  ELECTRIC_SHOCK: 'There is a risk of electric shock.',
  SPARKING: 'Sparking was reported.',
  BURNING_SMELL: 'A burning smell was reported.',
  MAJOR_LEAK: 'A major water leak was reported.',
  FLOODING: 'The area is flooding.',
  STRUCTURAL: 'There is structural damage.',
  EXPOSED_WIRE: 'Live wiring is exposed.',
  SECURITY_THREAT: 'A security threat was reported.',
  HARASSMENT: 'Harassment was reported.',
  INJURY: 'There is a risk of injury.',
  FOOD_ILLNESS: 'The food may have made people ill.',
  SEWAGE: 'Sewage is involved.',
};

const SCOPE_SENTENCE: Record<ScopeLevel, string> = {
  ONLY_ME: 'Only the reporter is affected.',
  FEW: 'A few students are affected.',
  MANY: 'Multiple students are affected.',
  BUILDING: 'The whole building is affected.',
  CAMPUS: 'The issue affects the entire campus.',
  UNKNOWN: 'How many people are affected is not known.',
};

const IMPACT_SENTENCE: Record<ImpactLevel, string> = {
  EXAM: 'An examination is being disrupted.',
  CLASS: 'Academic activity is being disrupted.',
  ASSIGNMENT: 'A submission deadline is at risk.',
  NONE: 'Nothing urgent is blocked.',
  UNKNOWN: 'Impact on academic activity is not known.',
};

const DURATION_SENTENCE: Record<DurationLevel, string> = {
  JUST_NOW: 'It has just started.',
  TODAY: 'It has been going on since today.',
  ONE_DAY: 'It has been unresolved for more than a day.',
  MULTI_DAY: 'It has been unresolved for several days.',
  UNKNOWN: 'How long it has been happening is not known.',
};

const LOCATION_SENTENCE: Record<LocationType, string> = {
  CAMPUS: 'It affects shared campus infrastructure.',
  ACADEMIC: 'The issue is in an academic building.',
  LAB: 'The issue is in a laboratory.',
  LIBRARY: 'The issue is in the library.',
  HOSTEL: 'The issue is in student housing.',
  CANTEEN: 'The issue is in a food-service area.',
  TRANSPORT: 'The issue affects campus transport.',
  OUTDOOR: 'The issue is in an outdoor area.',
  ADMIN_BLOCK: 'The issue is in the administrative block.',
};

export function assessPriority(input: PriorityInput): PriorityResult {
  const c = input.classification;
  const recurrenceCount = input.recurrenceCount ?? 0;
  const reasons: PriorityReason[] = [];

  const base = CATEGORY_BASE[c.categoryKey] ?? DEFAULT_CATEGORY_BASE;
  reasons.push({
    code: 'CATEGORY',
    label: `${c.categoryLabel} issues start at a base priority of ${base}.`,
    points: base,
    detail: c.subcategoryLabel ? `Reported as: ${c.subcategoryLabel}` : undefined,
  });

  const worstHazard = c.hazards[0];
  if (worstHazard) {
    reasons.push({
      code: 'HAZARD',
      label: HAZARD_SENTENCE[worstHazard],
      points: HAZARD_WEIGHT[worstHazard],
      detail:
        c.hazards.length > 1
          ? `Also reported: ${c.hazards.slice(1).join(', ')} (the worst hazard is scored, not the sum)`
          : undefined,
    });
  }

  // A person at risk is only meaningful next to something that could harm them.
  if (c.personAtRisk === true && c.hazards.length > 0) {
    reasons.push({
      code: 'PERSON_AT_RISK',
      label: 'Someone is at risk right now.',
      points: PERSON_AT_RISK_WEIGHT,
    });
  }

  if (SCOPE_WEIGHT[c.scope] > 0) {
    reasons.push({ code: 'SCOPE', label: SCOPE_SENTENCE[c.scope], points: SCOPE_WEIGHT[c.scope] });
  }

  if (IMPACT_WEIGHT[c.impact] > 0) {
    reasons.push({ code: 'IMPACT', label: IMPACT_SENTENCE[c.impact], points: IMPACT_WEIGHT[c.impact] });
  }

  if (DURATION_WEIGHT[c.duration] > 0) {
    reasons.push({
      code: 'DURATION',
      label: DURATION_SENTENCE[c.duration],
      points: DURATION_WEIGHT[c.duration],
    });
  }

  const criticality = c.locationCriticality ?? ASSUMED_CRITICALITY;
  const locationPoints = Math.round(criticality * LOCATION_WEIGHT_MAX);
  if (locationPoints > 0) {
    reasons.push({
      code: 'LOCATION',
      label: c.locationType
        ? LOCATION_SENTENCE[c.locationType]
        : 'The exact location has not been identified.',
      points: locationPoints,
      detail: c.locationName
        ? `${c.locationName} — criticality ${criticality.toFixed(2)}`
        : `Assumed campus-average criticality ${criticality.toFixed(2)}`,
    });
  }

  if (recurrenceCount >= RECURRENCE_THRESHOLD) {
    reasons.push({
      code: 'RECURRENCE',
      label: `This keeps coming back — ${recurrenceCount} similar reports here recently.`,
      points: RECURRENCE_WEIGHT,
      detail: `Signature ${c.signature}`,
    });
  } else if (c.reportedRecurring) {
    reasons.push({
      code: 'RECURRENCE',
      label: 'The student reports this has happened before.',
      points: REPORTED_RECURRENCE_WEIGHT,
    });
  }

  const score = reasons.reduce((sum, r) => sum + r.points, 0);
  const overrides = findOverrides(c, input.safetyShortCircuit === true);
  const band = overrides.length > 0 ? 'CRITICAL' : bandForScore(score);

  if (overrides.length > 0) {
    // Placed first so the override is the first thing anyone reads.
    reasons.unshift({
      code: 'OVERRIDE',
      label: 'Treated as critical immediately because of an active safety risk.',
      points: 0,
      detail: overrides.join('; '),
    });
  }

  // Worst-first, but the override sentence and the category floor keep their place.
  const ordered = [
    ...reasons.filter((r) => r.code === 'OVERRIDE'),
    ...reasons.filter((r) => r.code !== 'OVERRIDE' && r.code !== 'CATEGORY').sort((a, b) => b.points - a.points),
    ...reasons.filter((r) => r.code === 'CATEGORY'),
  ];

  return { band, score, reasons: ordered, overrides };
}

function findOverrides(c: Classification, safetyShortCircuit: boolean): string[] {
  const overrides: string[] = [];

  if (safetyShortCircuit) {
    overrides.push('A safety question was answered with a live-danger value');
  }

  const critical = c.hazards.filter((h) => CRITICAL_HAZARDS.includes(h));
  if (critical.length > 0) {
    overrides.push(`Critical hazard reported: ${critical.join(', ')}`);
  }

  if (c.personAtRisk === true && c.hazards.length > 0) {
    overrides.push('Someone is at risk next to a reported hazard');
  }

  return overrides;
}

/**
 * The student-facing "why" (§14). Drops the category floor — "Electrical issues
 * start at 40" explains the arithmetic, not the urgency — and keeps the sentences
 * that describe this complaint.
 */
export function studentReasons(result: PriorityResult, limit = 4): string[] {
  return result.reasons
    .filter((r) => r.code !== 'CATEGORY')
    .filter((r) => r.code === 'OVERRIDE' || r.points > 0)
    .slice(0, limit)
    .map((r) => r.label);
}
