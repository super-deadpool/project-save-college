import type { LocationType } from '@/generated/prisma/enums';
import { labelForValue } from './summary';
import type { CategorySchema, Hazard, Slot, SlotSignal, SlotValues } from './types';

/**
 * Normalisation, spec §13: an answered slot set becomes the flat set of facts the
 * rest of the system reasons about — category, subcategory, scope, impact,
 * duration, hazards, location — plus the dedup signature.
 *
 * Pure by design (CLAUDE.md §5). Location facts are passed in by the caller
 * because they live in the database; nothing here reads Prisma or the network.
 *
 * Categories word their questions differently, so this module never matches on a
 * category's slot keys or option values. It reads `slot.signal` and
 * `option.hazard` — declared by each schema — which is what lets one rubric score
 * all 13 categories.
 */

export type ScopeLevel = 'ONLY_ME' | 'FEW' | 'MANY' | 'BUILDING' | 'CAMPUS' | 'UNKNOWN';
export type ImpactLevel = 'EXAM' | 'CLASS' | 'ASSIGNMENT' | 'NONE' | 'UNKNOWN';
export type DurationLevel = 'JUST_NOW' | 'TODAY' | 'ONE_DAY' | 'MULTI_DAY' | 'UNKNOWN';

/**
 * Dedup groups on how *wide* an issue is, not on the exact answer: four students
 * describing the same outage as "the whole floor", "everyone here" and "the whole
 * block" must land on one signature (§16).
 */
export type ScopeBucket = 'ISOLATED' | 'WIDESPREAD' | 'UNKNOWN';

export const SCOPE_LEVELS: ScopeLevel[] = ['ONLY_ME', 'FEW', 'MANY', 'BUILDING', 'CAMPUS'];
export const IMPACT_LEVELS: ImpactLevel[] = ['EXAM', 'CLASS', 'ASSIGNMENT', 'NONE'];
export const DURATION_LEVELS: DurationLevel[] = ['JUST_NOW', 'TODAY', 'ONE_DAY', 'MULTI_DAY'];

/** Severity order — `hazards` is sorted by this so the worst one reads first. */
export const HAZARD_ORDER: Hazard[] = [
  'FIRE',
  'GAS_LEAK',
  'SMOKE',
  'ELECTRIC_SHOCK',
  'SPARKING',
  'BURNING_SMELL',
  'CHEMICAL',
  'STRUCTURAL',
  'FLOODING',
  'MAJOR_LEAK',
  'SECURITY_THREAT',
  'HARASSMENT',
  'INJURY',
  'FOOD_ILLNESS',
  'SEWAGE',
  'EXPOSED_WIRE',
];

export interface LocationFacts {
  id: string;
  name?: string | null;
  type: LocationType | null;
  /** 0..1, seeded per location. */
  criticality: number | null;
}

export interface Classification {
  categoryKey: string;
  categoryLabel: string;
  subcategoryKey: string | null;
  subcategoryLabel: string | null;
  scope: ScopeLevel;
  scopeBucket: ScopeBucket;
  impact: ImpactLevel;
  duration: DurationLevel;
  /** Worst first. Empty when nothing dangerous was reported. */
  hazards: Hazard[];
  /** null when never established — distinct from an answered "no". */
  personAtRisk: boolean | null;
  /** The student said this has happened before (§8 hostel / food). */
  reportedRecurring: boolean;
  locationId: string | null;
  locationName: string | null;
  locationType: LocationType | null;
  locationCriticality: number | null;
  /** `category|subcategory|location|scopeBucket` — Layer 5 dedup groups on this. */
  signature: string;
  /**
   * 0..1 — how much of the classification came from real answers rather than
   * defaults or gaps. Feeds the confidence-based human review in §41.
   */
  confidence: number;
  /** Signals that could not be established, for the triage explanation. */
  unresolved: string[];
}

/** Slots a schema declares as carrying a given shared signal. */
export function slotsWithSignal(schema: CategorySchema, signal: SlotSignal): Slot[] {
  return schema.slots.filter((s) => s.signal === signal);
}

/**
 * Read a signal slot's answer, keeping only values in the canonical vocabulary —
 * a schema typo becomes "unknown", never a value the rubric silently ignores.
 */
function readEnumSignal<T extends string>(
  schema: CategorySchema,
  slots: SlotValues,
  signal: SlotSignal,
  allowed: T[],
): T | null {
  for (const slot of slotsWithSignal(schema, signal)) {
    const entry = slots[slot.key];
    if (!entry || entry.state === 'SKIPPED') continue;
    const values = Array.isArray(entry.value) ? entry.value : [entry.value];
    for (const value of values) {
      if (typeof value === 'string' && (allowed as string[]).includes(value)) return value as T;
    }
  }
  return null;
}

function readBooleanSignal(
  schema: CategorySchema,
  slots: SlotValues,
  signal: SlotSignal,
): boolean | null {
  for (const slot of slotsWithSignal(schema, signal)) {
    const entry = slots[slot.key];
    if (!entry || entry.state === 'SKIPPED') continue;
    // A DEFAULTED value counts: `unsureDefault: true` on "is anyone at risk"
    // exists precisely so that "I'm not sure" is treated as a risk (§10).
    if (typeof entry.value === 'boolean') return entry.value;
  }
  return null;
}

/** Every hazard the answers indicate, via the `hazard` marker on options. */
export function collectHazards(schema: CategorySchema, slots: SlotValues): Hazard[] {
  const found = new Set<Hazard>();

  for (const slot of schema.slots) {
    if (!slot.options) continue;
    const entry = slots[slot.key];
    if (!entry || entry.state === 'SKIPPED') continue;
    // UNKNOWN is kept: a defaulted safety answer is deliberately pessimistic.
    const values = Array.isArray(entry.value) ? entry.value : [entry.value];
    for (const option of slot.options) {
      if (option.hazard && values.includes(option.value)) found.add(option.hazard);
    }
  }

  return HAZARD_ORDER.filter((h) => found.has(h));
}

export function scopeBucketOf(scope: ScopeLevel): ScopeBucket {
  if (scope === 'ONLY_ME' || scope === 'FEW') return 'ISOLATED';
  if (scope === 'UNKNOWN') return 'UNKNOWN';
  return 'WIDESPREAD';
}

/**
 * A readable composite rather than a digest. plan.MD §5 called for a hash; a
 * stable delimited key groups identically, survives in SQL `GROUP BY`, and can
 * be read straight off a row when a dedup decision needs explaining.
 */
export function computeSignature(parts: {
  categoryKey: string;
  subcategoryKey?: string | null;
  locationId?: string | null;
  scopeBucket: ScopeBucket;
}): string {
  return [
    parts.categoryKey,
    parts.subcategoryKey ?? 'NONE',
    parts.locationId ?? 'NOLOC',
    parts.scopeBucket,
  ].join('|');
}

function subcategoryOf(schema: CategorySchema, slots: SlotValues) {
  const slot = schema.slots.find((s) => s.key === schema.subcategorySlot);
  const entry = slot ? slots[slot.key] : undefined;
  if (!slot || !entry || entry.state === 'SKIPPED' || entry.value == null) {
    return { key: null, label: null };
  }
  const key = Array.isArray(entry.value) ? String(entry.value[0]) : String(entry.value);
  return { key, label: labelForValue(slot, key) };
}

/**
 * How much of the classification rests on real answers. Counts the slots that
 * matter for processing (REQUIRED + RECOMMENDED, currently relevant); a value the
 * student actually gave or that was extracted from their words counts fully, a
 * default or a gap does not.
 */
function confidenceOf(schema: CategorySchema, slots: SlotValues) {
  const considered = schema.slots.filter((s) => s.importance !== 'OPTIONAL');
  if (considered.length === 0) return { confidence: 1, unresolved: [] as string[] };

  const unresolved: string[] = [];
  let grounded = 0;

  for (const slot of considered) {
    const entry = slots[slot.key];
    if (entry?.state === 'FILLED') grounded += 1;
    else if (!entry || entry.state === 'UNKNOWN') unresolved.push(slot.key);
  }

  return {
    confidence: Math.round((grounded / considered.length) * 100) / 100,
    unresolved,
  };
}

export function classify(
  schema: CategorySchema,
  slots: SlotValues,
  location?: LocationFacts | null,
): Classification {
  const subcategory = subcategoryOf(schema, slots);
  const scope = readEnumSignal(schema, slots, 'SCOPE', SCOPE_LEVELS) ?? 'UNKNOWN';
  const scopeBucket = scopeBucketOf(scope);
  const { confidence, unresolved } = confidenceOf(schema, slots);

  return {
    categoryKey: schema.key,
    categoryLabel: schema.label,
    subcategoryKey: subcategory.key,
    subcategoryLabel: subcategory.label,
    scope,
    scopeBucket,
    impact: readEnumSignal(schema, slots, 'IMPACT', IMPACT_LEVELS) ?? 'UNKNOWN',
    duration: readEnumSignal(schema, slots, 'DURATION', DURATION_LEVELS) ?? 'UNKNOWN',
    hazards: collectHazards(schema, slots),
    personAtRisk: readBooleanSignal(schema, slots, 'PERSON_AT_RISK'),
    reportedRecurring: readBooleanSignal(schema, slots, 'RECURRING') === true,
    locationId: location?.id ?? null,
    locationName: location?.name ?? null,
    locationType: location?.type ?? null,
    locationCriticality: location?.criticality ?? null,
    signature: computeSignature({
      categoryKey: schema.key,
      subcategoryKey: subcategory.key,
      locationId: location?.id ?? null,
      scopeBucket,
    }),
    confidence,
    unresolved,
  };
}
