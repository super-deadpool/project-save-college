import { describe, expect, it } from 'vitest';
import {
  resolveRouting,
  TRIAGE_CONFIDENCE_THRESHOLD,
  type RoutingRuleInput,
} from '@/lib/engine/routing';

/** Mirrors how prisma/seed.ts builds the table: default 0 · type 10 · exact 20. */
const rule = (over: Partial<RoutingRuleInput> & { id: string }): RoutingRuleInput => ({
  categoryKey: 'ELECTRICAL',
  subcategoryKey: null,
  locationType: null,
  locationId: null,
  departmentId: 'dept-mnt',
  specificity: 0,
  confidence: 0.9,
  ...over,
});

const RULES: RoutingRuleInput[] = [
  rule({ id: 'default-electrical' }),
  rule({ id: 'hostel-electrical', locationType: 'HOSTEL', departmentId: 'dept-hostel', specificity: 10, confidence: 0.85 }),
  rule({ id: 'lab-electrical', locationType: 'LAB', departmentId: 'dept-mnt', specificity: 10, confidence: 0.9 }),
  rule({ id: 'exact-hostel-a', locationId: 'loc-hostel-a', departmentId: 'dept-hostel', specificity: 20, confidence: 0.95 }),
  rule({ id: 'default-network', categoryKey: 'NETWORK', departmentId: 'dept-it', confidence: 0.95 }),
  rule({ id: 'vague-lab-other', categoryKey: 'LAB_OTHER', departmentId: 'dept-it', confidence: 0.6 }),
];

describe('routing — §15 department identification', () => {
  it('falls back to the category default when nothing more specific matches', () => {
    const d = resolveRouting(RULES, {
      categoryKey: 'ELECTRICAL',
      locationIds: ['loc-cse'],
      locationType: 'ACADEMIC',
    });

    expect(d.matchedRuleId).toBe('default-electrical');
    expect(d.departmentId).toBe('dept-mnt');
    expect(d.needsTriage).toBe(false);
    expect(d.reason).toContain('category default');
  });

  it('prefers a location-type override over the category default', () => {
    const d = resolveRouting(RULES, {
      categoryKey: 'ELECTRICAL',
      locationIds: ['loc-hostel-b'],
      locationType: 'HOSTEL',
    });

    expect(d.matchedRuleId).toBe('hostel-electrical');
    expect(d.departmentId).toBe('dept-hostel');
  });

  it('prefers an exact-location rule over a location-type one', () => {
    const d = resolveRouting(RULES, {
      categoryKey: 'ELECTRICAL',
      locationIds: ['loc-hostel-a-214', 'loc-hostel-a', 'loc-campus'],
      locationType: 'HOSTEL',
    });

    expect(d.matchedRuleId).toBe('exact-hostel-a');
    expect(d.confidence).toBeCloseTo(0.95, 5);
  });

  it('reduces confidence when the location could not be identified', () => {
    const located = resolveRouting(RULES, {
      categoryKey: 'NETWORK',
      locationIds: ['loc-cse'],
      locationType: 'ACADEMIC',
    });
    const unlocated = resolveRouting(RULES, { categoryKey: 'NETWORK' });

    expect(located.confidence).toBeCloseTo(0.95, 5);
    expect(unlocated.confidence).toBeCloseTo(0.8, 5);
    expect(unlocated.reason).toContain('location not identified');
    // Still routable — a reduced score is not the same as a guess.
    expect(unlocated.departmentId).toBe('dept-it');
    expect(unlocated.needsTriage).toBe(false);
  });

  it('sends a low-confidence match to triage instead of guessing (§41)', () => {
    const d = resolveRouting(RULES, { categoryKey: 'LAB_OTHER' });

    // 0.60 base minus the unknown-location penalty lands below the threshold.
    expect(d.confidence).toBeLessThan(TRIAGE_CONFIDENCE_THRESHOLD);
    expect(d.needsTriage).toBe(true);
  });

  it('sends an unroutable category to triage with no department', () => {
    const d = resolveRouting(RULES, { categoryKey: 'CANTEEN', locationType: 'CANTEEN' });

    expect(d.departmentId).toBeNull();
    expect(d.needsTriage).toBe(true);
    expect(d.matchedRuleId).toBeNull();
    expect(d.reason).toContain('No routing rule');
  });

  it('is deterministic when two rules are equally specific', () => {
    const tie: RoutingRuleInput[] = [
      rule({ id: 'b-rule', departmentId: 'dept-b' }),
      rule({ id: 'a-rule', departmentId: 'dept-a' }),
    ];

    const first = resolveRouting(tie, { categoryKey: 'ELECTRICAL', locationType: 'ACADEMIC' });
    const again = resolveRouting([...tie].reverse(), {
      categoryKey: 'ELECTRICAL',
      locationType: 'ACADEMIC',
    });

    expect(first.matchedRuleId).toBe('a-rule');
    expect(again.matchedRuleId).toBe('a-rule');
  });

  it('honours a subcategory-scoped rule only for that subcategory', () => {
    const rules = [
      ...RULES,
      rule({
        id: 'wiring-to-safety',
        subcategoryKey: 'EXPOSED_WIRING',
        departmentId: 'dept-safety',
        specificity: 10,
        confidence: 0.95,
      }),
    ];

    const wiring = resolveRouting(rules, {
      categoryKey: 'ELECTRICAL',
      subcategoryKey: 'EXPOSED_WIRING',
      locationType: 'ACADEMIC',
    });
    const fan = resolveRouting(rules, {
      categoryKey: 'ELECTRICAL',
      subcategoryKey: 'FAN_NOT_WORKING',
      locationType: 'ACADEMIC',
    });

    expect(wiring.departmentId).toBe('dept-safety');
    expect(fan.departmentId).toBe('dept-mnt');
  });
});
