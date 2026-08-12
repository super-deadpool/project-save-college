import { describe, expect, it } from 'vitest';
import { classify, type LocationFacts } from '@/lib/engine/classify';
import { hasSafetyShortCircuit } from '@/lib/engine/completeness';
import {
  assessPriority,
  bandForScore,
  CATEGORY_BASE,
  studentReasons,
  type PriorityResult,
} from '@/lib/engine/priority';
import { ALL_CATEGORY_KEYS, getCategory } from '@/lib/engine/schemas';
import type { SlotValues } from '@/lib/engine/types';

function filled(values: Record<string, unknown>): SlotValues {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      { value, state: 'FILLED' as const, source: 'ANSWERED' as const, confidence: 1 },
    ]),
  );
}

const loc = (
  name: string,
  type: LocationFacts['type'],
  criticality: number,
): LocationFacts => ({ id: `loc-${name}`, name, type, criticality });

const EXAM_HALL = loc('CSE 201 (Exam Hall)', 'ACADEMIC', 0.95);
const CSE_BLOCK = loc('CSE Block', 'ACADEMIC', 0.7);
const HOSTEL_A = loc('Boys Hostel A', 'HOSTEL', 0.6);
const MESS = loc('Boys Hostel A Mess', 'CANTEEN', 0.65);
const BUS_BAY = loc('Bus Bay', 'TRANSPORT', 0.5);
const CAMPUS = loc('Campus', 'CAMPUS', 0.5);

/**
 * Runs a complaint the way the app does: classify the answers, read the safety
 * short-circuit off the schema, then score. Nothing about the rubric is mocked.
 */
function assess(
  categoryKey: string,
  answers: Record<string, unknown>,
  location: LocationFacts | null,
  recurrenceCount = 0,
): PriorityResult {
  const schema = getCategory(categoryKey)!;
  const slots = filled(answers);
  return assessPriority({
    classification: classify(schema, slots, location),
    safetyShortCircuit: hasSafetyShortCircuit(schema, slots),
    recurrenceCount,
  });
}

describe('bands', () => {
  it('pins the thresholds from plan.MD §4', () => {
    expect(bandForScore(120)).toBe('CRITICAL');
    expect(bandForScore(119)).toBe('HIGH');
    expect(bandForScore(75)).toBe('HIGH');
    expect(bandForScore(74)).toBe('MEDIUM');
    expect(bandForScore(40)).toBe('MEDIUM');
    expect(bandForScore(39)).toBe('LOW');
    expect(bandForScore(0)).toBe('LOW');
  });

  it('gives every category a base', () => {
    for (const key of ALL_CATEGORY_KEYS) {
      expect(CATEGORY_BASE[key], key).toBeGreaterThan(0);
    }
  });
});

describe('§14 CRITICAL', () => {
  it('electrical safety hazard — smoke', () => {
    const r = assess(
      'ELECTRICAL',
      { safety_hazard: ['SMOKE'], problem_type: 'SOCKET_NOT_WORKING' },
      CSE_BLOCK,
    );
    expect(r.band).toBe('CRITICAL');
    expect(r.overrides.length).toBeGreaterThan(0);
  });

  it('fire-related issue', () => {
    const r = assess('LAB_OTHER', { lab_hazard: ['FIRE'], problem_type: 'EQUIPMENT_BROKEN' }, CSE_BLOCK);
    expect(r.band).toBe('CRITICAL');
  });

  it('major water leakage', () => {
    const r = assess(
      'WATER',
      { water_hazard: ['NONE'], problem_type: 'PIPE_BURST', scope: 'FEW' },
      HOSTEL_A,
    );
    expect(r.band).toBe('CRITICAL');
    // No safety-slot value was critical; the hazard on the problem type carried it.
    expect(r.overrides.join(' ')).toContain('MAJOR_LEAK');
  });

  it('security threat happening now', () => {
    const r = assess('SECURITY', { problem_type: 'INTRUDER', happening_now: true }, HOSTEL_A);
    expect(r.band).toBe('CRITICAL');
  });

  it('campus-wide infrastructure failure reaches CRITICAL on score alone', () => {
    const r = assess(
      'ELECTRICAL',
      {
        safety_hazard: ['NONE'],
        problem_type: 'NO_POWER',
        scope: 'CAMPUS',
        duration: 'TODAY',
        impact: 'EXAM',
      },
      CAMPUS,
    );
    expect(r.band).toBe('CRITICAL');
    expect(r.overrides).toEqual([]);
    expect(r.score).toBeGreaterThanOrEqual(120);
  });

  it('someone at risk beside a non-critical hazard', () => {
    const exposedOnly = assess(
      'ELECTRICAL',
      { safety_hazard: ['EXPOSED_WIRE'], person_at_risk: false, problem_type: 'EXPOSED_WIRING' },
      HOSTEL_A,
    );
    const someoneNear = assess(
      'ELECTRICAL',
      { safety_hazard: ['EXPOSED_WIRE'], person_at_risk: true, problem_type: 'EXPOSED_WIRING' },
      HOSTEL_A,
    );

    // Exposed wiring alone is serious but not automatically critical…
    expect(exposedOnly.band).toBe('HIGH');
    expect(exposedOnly.overrides).toEqual([]);
    // …a person beside it is (§7's example question, made load-bearing).
    expect(someoneNear.band).toBe('CRITICAL');
  });

  it('agrees with the conversation short-circuit, so a halted chat never submits as less', () => {
    const schema = getCategory('HOSTEL_FOOD')!;
    const slots = filled({
      problem_type: 'STALE',
      health_impact: 'MULTIPLE_UNWELL',
      scope: 'MANY',
    });

    expect(hasSafetyShortCircuit(schema, slots)).toBe(true);
    const r = assessPriority({
      classification: classify(schema, slots, MESS),
      safetyShortCircuit: true,
    });
    // Score alone would be HIGH; the short-circuit is what makes it CRITICAL.
    expect(r.score).toBeLessThan(120);
    expect(r.band).toBe('CRITICAL');
  });

  it('does not treat a person at risk as critical when nothing hazardous was reported', () => {
    const schema = getCategory('ELECTRICAL')!;
    const slots: SlotValues = filled({
      safety_hazard: ['NONE'],
      problem_type: 'FAN_NOT_WORKING',
      scope: 'ONLY_ME',
    });
    const c = classify(schema, slots, HOSTEL_A);
    const r = assessPriority({ classification: { ...c, personAtRisk: true } });

    expect(r.overrides).toEqual([]);
    expect(r.band).not.toBe('CRITICAL');
  });
});

describe('§14 HIGH', () => {
  it('wifi outage during examinations', () => {
    const r = assess(
      'NETWORK',
      { problem_type: 'NO_CONNECTION', scope: 'MANY', impact: 'EXAM', duration: 'TODAY' },
      EXAM_HALL,
    );
    expect(r.band).toBe('HIGH');
  });

  it('major classroom disruption', () => {
    const r = assess(
      'CLASSROOM',
      { problem_type: 'AUDIO', scope: 'BUILDING', impact: 'CLASS', duration: 'TODAY' },
      CSE_BLOCK,
    );
    expect(r.band).toBe('HIGH');
  });

  it('hostel electricity failure', () => {
    const r = assess(
      'ELECTRICAL',
      {
        safety_hazard: ['NONE'],
        problem_type: 'NO_POWER',
        scope: 'BUILDING',
        duration: 'ONE_DAY',
        impact: 'NONE',
      },
      HOSTEL_A,
    );
    expect(r.band).toBe('HIGH');
  });

  it('hostel water failure', () => {
    const r = assess(
      'WATER',
      { water_hazard: ['NONE'], problem_type: 'NO_WATER', scope: 'BUILDING', duration: 'MULTI_DAY' },
      HOSTEL_A,
    );
    expect(r.band).toBe('HIGH');
  });

  it('transport breakdown affecting many students', () => {
    const r = assess(
      'TRANSPORT',
      { problem_type: 'BREAKDOWN', scope: 'MANY', impact: 'CLASS' },
      BUS_BAY,
    );
    expect(r.band).toBe('HIGH');
  });
});

describe('§14 MEDIUM and LOW', () => {
  it('broken classroom equipment is medium', () => {
    const r = assess(
      'CLASSROOM',
      { problem_type: 'PROJECTOR', scope: 'ONLY_ME', impact: 'CLASS', duration: 'TODAY' },
      CSE_BLOCK,
    );
    expect(r.band).toBe('MEDIUM');
  });

  it('partial wifi issue is medium', () => {
    const r = assess(
      'NETWORK',
      { problem_type: 'SLOW', scope: 'FEW', impact: 'NONE', duration: 'TODAY' },
      CSE_BLOCK,
    );
    expect(r.band).toBe('MEDIUM');
  });

  it('a minor furniture problem is low', () => {
    const r = assess(
      'FURNITURE',
      { injury_risk: 'NO', problem_type: 'CHAIR', scope: 'ONLY_ME', duration: 'TODAY' },
      CSE_BLOCK,
    );
    expect(r.band).toBe('LOW');
  });

  it('a non-urgent library request is low', () => {
    const r = assess(
      'LIBRARY',
      { problem_type: 'BOOK_UNAVAILABLE', scope: 'ONLY_ME', impact: 'NONE' },
      loc('Library', 'LIBRARY', 0.7),
    );
    expect(r.band).toBe('LOW');
  });
});

describe('individual rubric terms', () => {
  const base = {
    problem_type: 'NO_CONNECTION',
    scope: 'ONLY_ME',
    impact: 'NONE',
    duration: 'JUST_NOW',
  };

  it('scope raises the score monotonically', () => {
    const scores = ['ONLY_ME', 'FEW', 'MANY', 'BUILDING', 'CAMPUS'].map(
      (scope) => assess('NETWORK', { ...base, scope }, CSE_BLOCK).score,
    );
    expect(scores).toEqual([...scores].sort((a, b) => a - b));
    expect(new Set(scores).size).toBe(scores.length);
  });

  it('impact and duration raise the score monotonically', () => {
    const impacts = ['NONE', 'ASSIGNMENT', 'CLASS', 'EXAM'].map(
      (impact) => assess('NETWORK', { ...base, impact }, CSE_BLOCK).score,
    );
    const durations = ['JUST_NOW', 'TODAY', 'ONE_DAY', 'MULTI_DAY'].map(
      (duration) => assess('NETWORK', { ...base, duration }, CSE_BLOCK).score,
    );
    expect(impacts).toEqual([...impacts].sort((a, b) => a - b));
    expect(durations).toEqual([...durations].sort((a, b) => a - b));
  });

  it('scores the worst hazard rather than the sum', () => {
    const one = assess('ELECTRICAL', { safety_hazard: ['EXPOSED_WIRE'], problem_type: 'EXPOSED_WIRING' }, HOSTEL_A);
    const two = assess(
      'ELECTRICAL',
      { safety_hazard: ['EXPOSED_WIRE'], problem_type: 'EXPOSED_WIRING', scope: 'ONLY_ME' },
      HOSTEL_A,
    );
    expect(one.score).toBe(two.score);

    const hazardReason = one.reasons.find((r) => r.code === 'HAZARD');
    expect(hazardReason?.points).toBe(50);
  });

  it('a location it could not identify scores the campus average, not zero', () => {
    const unknown = assess('NETWORK', base, null);
    const located = assess('NETWORK', base, CSE_BLOCK);

    expect(unknown.score).toBeGreaterThan(0);
    expect(unknown.score).toBeLessThan(located.score);
    expect(unknown.reasons.find((r) => r.code === 'LOCATION')?.label).toContain('not been identified');
  });

  it('counts recurrence from history above a student saying it recurs', () => {
    const once = assess('SANITATION', { problem_type: 'BAD_SMELL', scope: 'FEW' }, HOSTEL_A);
    const reported = assess(
      'SANITATION',
      { problem_type: 'BAD_SMELL', scope: 'FEW', recurring: true },
      HOSTEL_A,
    );
    const historical = assess('SANITATION', { problem_type: 'BAD_SMELL', scope: 'FEW' }, HOSTEL_A, 4);

    expect(reported.score - once.score).toBe(5);
    expect(historical.score - once.score).toBe(10);
    expect(historical.reasons.find((r) => r.code === 'RECURRENCE')?.label).toContain('4 similar reports');
  });

  it('does not double-count recurrence when both signals are present', () => {
    const both = assess(
      'SANITATION',
      { problem_type: 'BAD_SMELL', scope: 'FEW', recurring: true },
      HOSTEL_A,
      4,
    );
    expect(both.reasons.filter((r) => r.code === 'RECURRENCE')).toHaveLength(1);
  });
});

describe('§14 requires the reason', () => {
  it('returns sentences a student can read, worst first', () => {
    const r = assess(
      'NETWORK',
      { problem_type: 'NO_CONNECTION', scope: 'MANY', impact: 'CLASS', duration: 'TODAY' },
      CSE_BLOCK,
    );
    const reasons = studentReasons(r);

    expect(reasons).toContain('Multiple students are affected.');
    expect(reasons).toContain('Academic activity is being disrupted.');
    expect(reasons).toContain('The issue is in an academic building.');
    // The arithmetic of the category floor is not a reason for urgency.
    expect(reasons.join(' ')).not.toContain('base priority');
    expect(reasons.every((r) => r.endsWith('.'))).toBe(true);
  });

  it('leads with the override when one fired', () => {
    const r = assess('ELECTRICAL', { safety_hazard: ['SMOKE'], problem_type: 'NO_POWER' }, HOSTEL_A);
    expect(studentReasons(r)[0]).toContain('critical');
    expect(r.reasons[0].code).toBe('OVERRIDE');
  });

  it('never returns a band with no reasons at all', () => {
    for (const key of ALL_CATEGORY_KEYS) {
      const schema = getCategory(key)!;
      const problem = schema.slots.find((s) => s.key === schema.subcategorySlot)!;
      const r = assess(key, { [problem.key]: problem.options![0].value }, CSE_BLOCK);
      expect(r.reasons.length, key).toBeGreaterThan(0);
      expect(studentReasons(r).length, key).toBeGreaterThan(0);
    }
  });
});
