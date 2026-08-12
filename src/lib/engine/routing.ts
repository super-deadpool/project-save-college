import type { LocationType } from '@/generated/prisma/enums';

/**
 * Routing is deterministic and table-driven (plan.MD §4). This module is pure:
 * the caller loads the rules, this decides. Specificity ordering is
 * exact location (20) > location type (10) > category default (0).
 */

export interface RoutingRuleInput {
  id: string;
  categoryKey: string;
  subcategoryKey: string | null;
  locationType: LocationType | null;
  locationId: string | null;
  departmentId: string;
  specificity: number;
  confidence: number;
}

export interface RoutingContext {
  categoryKey: string;
  subcategoryKey?: string | null;
  /** The complaint's location plus its ancestors, nearest first. */
  locationIds?: string[];
  locationType?: LocationType | null;
}

export interface RoutingDecision {
  departmentId: string | null;
  confidence: number;
  /** Below this the complaint goes to the triage queue instead of a guess (§41). */
  needsTriage: boolean;
  matchedRuleId: string | null;
  reason: string;
}

export const TRIAGE_CONFIDENCE_THRESHOLD = 0.5;

export function resolveRouting(
  rules: RoutingRuleInput[],
  ctx: RoutingContext,
): RoutingDecision {
  const locationIds = ctx.locationIds ?? [];

  const candidates = rules
    .filter((r) => r.categoryKey === ctx.categoryKey)
    .filter((r) => !r.subcategoryKey || r.subcategoryKey === ctx.subcategoryKey)
    .filter((r) => !r.locationType || r.locationType === ctx.locationType)
    .filter((r) => !r.locationId || locationIds.includes(r.locationId));

  if (candidates.length === 0) {
    return {
      departmentId: null,
      confidence: 0,
      needsTriage: true,
      matchedRuleId: null,
      reason: `No routing rule matches category ${ctx.categoryKey} — sent to triage.`,
    };
  }

  // Most specific wins; ties break on confidence, then on rule id for stability.
  const best = [...candidates].sort(
    (a, b) =>
      effectiveSpecificity(b, locationIds) - effectiveSpecificity(a, locationIds) ||
      b.confidence - a.confidence ||
      a.id.localeCompare(b.id),
  )[0];

  // An unknown location means a location-type override could not be considered.
  const penalty = ctx.locationType ? 0 : 0.15;
  const confidence = Math.max(0, Math.min(1, best.confidence - penalty));

  return {
    departmentId: best.departmentId,
    confidence,
    needsTriage: confidence < TRIAGE_CONFIDENCE_THRESHOLD,
    matchedRuleId: best.id,
    reason: describe(best, ctx, penalty > 0),
  };
}

function effectiveSpecificity(rule: RoutingRuleInput, locationIds: string[]): number {
  if (rule.locationId) {
    // A nearer ancestor match is more specific than a distant one.
    const distance = locationIds.indexOf(rule.locationId);
    return 20 + Math.max(0, 5 - distance);
  }
  return rule.specificity;
}

function describe(rule: RoutingRuleInput, ctx: RoutingContext, unknownLocation: boolean): string {
  const parts: string[] = [];
  if (rule.locationId) parts.push('an exact-location rule');
  else if (rule.locationType) parts.push(`the ${rule.locationType.toLowerCase()} location rule`);
  else parts.push('the category default');
  let reason = `Routed by ${parts[0]} for ${ctx.categoryKey}`;
  if (rule.subcategoryKey) reason += ` / ${rule.subcategoryKey}`;
  if (unknownLocation) reason += ' (location not identified, confidence reduced)';
  return `${reason}.`;
}
