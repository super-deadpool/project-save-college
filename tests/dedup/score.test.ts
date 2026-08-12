import { describe, expect, it } from 'vitest';
import {
  AUTO_LINK_THRESHOLD,
  SUGGEST_THRESHOLD,
  bestMatch,
  locationProximity,
  scoreCandidate,
  signatureMatch,
  timeProximity,
  verdictFor,
  WEIGHTS,
  type DedupAttributes,
  type DedupCandidate,
} from '@/lib/dedup/score';

/**
 * The spec §16 scenario, in the shape dedup actually sees it — four students
 * whose *words* barely overlap but whose *attributes* are the same issue.
 *
 * Location tree (as seeded): campus → CSE Block → floor 3 → room 302.
 */
const CAMPUS = 'loc-campus';
const CSE = 'loc-cse';
const CSE_F3 = 'loc-cse-f3';
const CSE_302 = 'loc-cse-302';
const LIB = 'loc-library';

const CHAIN = {
  [CSE]: [CSE, CAMPUS],
  [CSE_F3]: [CSE_F3, CSE, CAMPUS],
  [CSE_302]: [CSE_302, CSE_F3, CSE, CAMPUS],
  [LIB]: [LIB, CAMPUS],
} as const;

const AT = new Date('2026-08-12T10:00:00Z');

const attrs = (over: Partial<DedupAttributes> = {}): DedupAttributes => ({
  categoryKey: 'NETWORK',
  subcategoryKey: 'WIFI_OUTAGE',
  scopeBucket: 'WIDESPREAD',
  locationId: CSE,
  locationAncestorIds: [...CHAIN[CSE]],
  createdAt: AT,
  ...over,
});

const candidate = (over: Partial<DedupCandidate> = {}): DedupCandidate => ({
  ...attrs(),
  complaintId: 'c-1',
  complaintCode: 'CMP-0001',
  incidentId: 'inc-1',
  reporterId: 'u-1',
  textSimilarity: 0.3,
  ...over,
});

const hoursLater = (h: number) => new Date(AT.getTime() + h * 3_600_000);

describe('signature match — the problem, not the place', () => {
  it('is 1.0 for two reports of the same problem at the same width', () => {
    expect(signatureMatch(attrs(), attrs())).toBe(1);
  });

  it('is 0 across categories — a candidate set never mixes them anyway', () => {
    expect(signatureMatch(attrs(), attrs({ categoryKey: 'ELECTRICAL' }))).toBe(0);
  });

  it('treats an UNKNOWN scope bucket as a wildcard, not a mismatch', () => {
    // Layer 4's carried note: the first report of an outage is usually the one
    // with the fewest answers. If UNKNOWN scored as "different", that complaint
    // could never be matched by the ones that follow it.
    expect(signatureMatch(attrs({ scopeBucket: 'UNKNOWN' }), attrs())).toBe(1);
    expect(signatureMatch(attrs(), attrs({ scopeBucket: 'UNKNOWN' }))).toBe(1);
  });

  it('penalises a genuine width disagreement without killing the match', () => {
    const m = signatureMatch(attrs({ scopeBucket: 'ISOLATED' }), attrs());
    expect(m).toBeCloseTo(0.6, 5);
  });

  it('penalises a different subcategory hard — same category, different fault', () => {
    expect(signatureMatch(attrs(), attrs({ subcategoryKey: 'SLOW_SPEED' }))).toBeCloseTo(0.35, 5);
  });

  it('gives partial credit when one side never established the subcategory', () => {
    expect(signatureMatch(attrs(), attrs({ subcategoryKey: null }))).toBeCloseTo(0.75, 5);
  });
});

describe('location proximity — plan.MD §5 ladder', () => {
  const at = (id: keyof typeof CHAIN) =>
    attrs({ locationId: id, locationAncestorIds: [...CHAIN[id]] });

  it('scores the same location 1.0', () => {
    expect(locationProximity(at(CSE_302), at(CSE_302))).toBe(1);
  });

  it('scores a room against its own floor as 0.7', () => {
    // §16's student 3 reports "the third floor"; student 4 reports room 302.
    expect(locationProximity(at(CSE_302), at(CSE_F3))).toBe(0.7);
    expect(locationProximity(at(CSE_F3), at(CSE_302))).toBe(0.7);
  });

  it('scores a floor against its own building as "same building"', () => {
    expect(locationProximity(at(CSE_F3), at(CSE))).toBe(0.5);
  });

  it('scores two rooms on different floors of one building as 0.5', () => {
    const other = attrs({
      locationId: 'loc-cse-201',
      locationAncestorIds: ['loc-cse-201', 'loc-cse-f2', CSE, CAMPUS],
    });
    expect(locationProximity(at(CSE_302), other)).toBe(0.5);
  });

  it('scores different buildings as 0.1 — same campus is barely evidence', () => {
    expect(locationProximity(at(CSE), at(LIB))).toBe(0.1);
  });

  it('is neither rewarded nor punished when a location was never given', () => {
    expect(locationProximity(attrs({ locationId: null, locationAncestorIds: [] }), at(CSE))).toBe(
      0.2,
    );
  });
});

describe('time proximity — decays across the category window', () => {
  it('is 1.0 at the same instant and 0 at the window edge', () => {
    expect(timeProximity(AT, AT, 24)).toBe(1);
    expect(timeProximity(AT, hoursLater(24), 24)).toBe(0);
  });

  it('halves at half the window', () => {
    expect(timeProximity(AT, hoursLater(12), 24)).toBe(0.5);
  });

  it('reads the window from the category, so furniture stays matchable for days', () => {
    // FURNITURE declares 72h; the same 48h gap that is worthless for NETWORK is
    // still meaningful for a broken chair.
    expect(timeProximity(AT, hoursLater(48), 24)).toBe(0);
    expect(timeProximity(AT, hoursLater(48), 72)).toBeCloseTo(0.33, 2);
  });
});

describe('verdicts — plan.MD §5 thresholds', () => {
  it('auto-links at 0.70 and suggests at 0.45', () => {
    expect(verdictFor(AUTO_LINK_THRESHOLD)).toBe('AUTO_LINKED');
    expect(verdictFor(AUTO_LINK_THRESHOLD - 0.01)).toBe('SUGGESTED');
    expect(verdictFor(SUGGEST_THRESHOLD)).toBe('SUGGESTED');
    expect(verdictFor(SUGGEST_THRESHOLD - 0.01)).toBe('NEW');
  });

  it('weights sum to 1, so a perfect match scores exactly 1.0', () => {
    const total = WEIGHTS.signature + WEIGHTS.location + WEIGHTS.text + WEIGHTS.time;
    expect(total).toBeCloseTo(1, 10);
  });
});

describe('§16 — the four phrasings land on one incident', () => {
  // Student 1 opens the incident: "WiFi isn't working in CSE Block."
  const first = candidate({
    complaintCode: 'CMP-0001',
    locationId: CSE,
    locationAncestorIds: [...CHAIN[CSE]],
  });

  it('student 2 — "No internet connection in CSE building", same words absent', () => {
    // Trigram similarity is deliberately low: these sentences share almost
    // nothing. Attributes carry the match, exactly as plan.MD §5 intends.
    const result = scoreCandidate(attrs(), { ...first, textSimilarity: 0.12 }, 24);
    expect(result.verdict).toBe('AUTO_LINKED');
    expect(result.parts.signature).toBe(1);
  });

  it('student 3 — "Network is down on the third floor", one level deeper', () => {
    const subject = attrs({
      locationId: CSE_F3,
      locationAncestorIds: [...CHAIN[CSE_F3]],
      createdAt: hoursLater(2),
    });
    const result = scoreCandidate(subject, { ...first, textSimilarity: 0.1 }, 24);
    // Student 1 named the building, student 3 a floor inside it — "same
    // building". The attribute signature is what carries this over the line.
    expect(result.parts.location).toBe(0.5);
    expect(result.verdict).toBe('AUTO_LINKED');
  });

  it('student 4 — "Unable to connect to campus WiFi", scope never asked', () => {
    const subject = attrs({ scopeBucket: 'UNKNOWN', createdAt: hoursLater(4) });
    const result = scoreCandidate(subject, { ...first, textSimilarity: 0.2 }, 24);
    expect(result.verdict).toBe('AUTO_LINKED');
  });

  it('an unrelated library complaint the same hour does not join them', () => {
    const subject = attrs({
      locationId: LIB,
      locationAncestorIds: [...CHAIN[LIB]],
      subcategoryKey: 'SLOW_SPEED',
    });
    const result = scoreCandidate(subject, { ...first, textSimilarity: 0.15 }, 24);
    expect(result.verdict).toBe('NEW');
  });
});

describe('the suggest band — confident enough to ask, not to act', () => {
  it('lands a same-building different-floor report a day later in the middle', () => {
    const subject = attrs({
      locationId: 'loc-cse-201',
      locationAncestorIds: ['loc-cse-201', 'loc-cse-f2', CSE, CAMPUS],
      subcategoryKey: null,
      createdAt: hoursLater(30),
    });
    const older = candidate({
      locationId: CSE_302,
      locationAncestorIds: [...CHAIN[CSE_302]],
      createdAt: AT,
      textSimilarity: 0.5,
    });
    const result = scoreCandidate(subject, older, 48);

    expect(result.score).toBeGreaterThanOrEqual(SUGGEST_THRESHOLD);
    expect(result.score).toBeLessThan(AUTO_LINK_THRESHOLD);
    expect(result.verdict).toBe('SUGGESTED');
  });

  it('explains itself — a dedup verdict is never a bare number', () => {
    const result = scoreCandidate(attrs(), candidate(), 24);
    expect(result.explain.length).toBeGreaterThan(1);
    expect(result.explain.join(' ')).toContain('CMP-0001');
  });
});

describe('bestMatch', () => {
  it('picks the strongest candidate', () => {
    const weak = candidate({ complaintId: 'c-weak', incidentId: 'inc-weak', subcategoryKey: 'SLOW_SPEED' });
    const strong = candidate({ complaintId: 'c-strong', incidentId: 'inc-strong' });

    expect(bestMatch(attrs(), [weak, strong], 24)?.candidate.incidentId).toBe('inc-strong');
  });

  it('breaks ties towards the earlier complaint so a burst converges', () => {
    const later = candidate({ complaintId: 'c-late', incidentId: 'inc-late', createdAt: AT });
    const earlier = candidate({
      complaintId: 'c-early',
      incidentId: 'inc-early',
      createdAt: hoursLater(-1),
    });
    // Equal on every component except time, which the earlier one loses — so
    // give them the same timestamp distance by scoring from the midpoint.
    const subject = attrs({ createdAt: hoursLater(-0.5) });
    expect(bestMatch(subject, [later, earlier], 24)?.candidate.complaintId).toBe('c-early');
  });

  it('returns null when there is nothing open to match against', () => {
    expect(bestMatch(attrs(), [], 24)).toBeNull();
  });
});
