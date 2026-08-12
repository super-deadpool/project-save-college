import type { ScopeBucket } from '@/lib/engine/classify';
import type { DedupVerdict } from '@/generated/prisma/enums';

/**
 * Duplicate scoring, spec §16 / plan.MD §5.
 *
 * The idea that makes this work without embeddings: dedup runs on *structured
 * attributes after classification*, not on raw text. "WiFi isn't working in CSE
 * Block" and "No internet connection in CSE building" both normalise to
 * `NETWORK / WIFI_OUTAGE / CSE_BLOCK`, so they match on attributes even though
 * they share almost no words. Trigram text similarity is a tie-breaker, never
 * the deciding signal — which is why it is worth only 0.15.
 *
 * Pure by design (CLAUDE.md §5): the caller does the SQL, including the
 * `similarity()` call, and passes numbers in. That is what lets every weight and
 * threshold below be pinned by a unit test.
 */

export const WEIGHTS = {
  signature: 0.55,
  location: 0.15,
  text: 0.15,
  time: 0.15,
} as const;

/** plan.MD §5: ≥0.70 auto-link · 0.45–0.70 suggest to staff · below that, new. */
export const AUTO_LINK_THRESHOLD = 0.7;
export const SUGGEST_THRESHOLD = 0.45;

/** The dedup-relevant shape of a complaint — the subject or a candidate. */
export interface DedupAttributes {
  categoryKey: string;
  subcategoryKey: string | null;
  scopeBucket: ScopeBucket;
  locationId: string | null;
  /** The location itself, then each ancestor up to campus. Empty when unlocated. */
  locationAncestorIds: string[];
  createdAt: Date;
}

export interface DedupCandidate extends DedupAttributes {
  complaintId: string;
  complaintCode: string;
  incidentId: string;
  reporterId: string;
  /** 0..1 from `similarity()` on title/description. The caller runs the SQL. */
  textSimilarity: number;
}

export interface DedupParts {
  signature: number;
  location: number;
  text: number;
  time: number;
}

export interface DedupScore {
  score: number;
  verdict: DedupVerdict;
  parts: DedupParts;
  /** One sentence per component — a dedup decision is explainable, like a band. */
  explain: string[];
}

/**
 * How much the *problem* matches: category, subcategory and how wide it is.
 *
 * Deliberately excludes the location leg of the stored signature even though
 * `computeSignature` includes it — location is scored separately below, and
 * counting it twice would let a same-building/different-room pair be punished
 * on 0.70 of the score instead of 0.15. Two complaints with identical stored
 * signatures still score 1.0 here.
 *
 * An `UNKNOWN` scope bucket is a **wildcard**, not a mismatch (Layer 4's carried
 * note): a student who was never asked how many people are affected must still
 * match one who was, or the very first complaint of an outage — the one that
 * usually has the fewest answers — would open its own incident every time.
 */
export function signatureMatch(a: DedupAttributes, b: DedupAttributes): number {
  if (a.categoryKey !== b.categoryKey) return 0;

  let match = 1;

  if (a.subcategoryKey && b.subcategoryKey) {
    // A different subcategory is a genuinely different problem — "no signal" and
    // "captive portal won't load" are both NETWORK and are not the same outage.
    match *= a.subcategoryKey === b.subcategoryKey ? 1 : 0.35;
  } else {
    // One side never established it. Partial credit: the evidence is missing,
    // not contradictory.
    match *= 0.75;
  }

  if (a.scopeBucket !== 'UNKNOWN' && b.scopeBucket !== 'UNKNOWN') {
    match *= a.scopeBucket === b.scopeBucket ? 1 : 0.6;
  }

  return round(match);
}

/**
 * Same room 1.0 · same floor 0.7 · same building 0.5 · same campus 0.1
 * (plan.MD §5), read off the ancestor chains rather than a hardcoded depth
 * table so it degrades sensibly wherever the tree is shallower than 4.
 *
 * The measure is **how specific the deepest shared ancestor is**, not how many
 * hops apart the two locations are. Those are different questions, and only the
 * first one is evidence: two buildings are one hop apart *through the campus
 * root*, which is the weakest possible relationship, not a close one.
 *
 * Containment falls out of the same rule — a room and its own floor share that
 * floor, so "network is down on the third floor" and "no wifi in room 302" score
 * 0.7 without a special case.
 */
export function locationProximity(a: DedupAttributes, b: DedupAttributes): number {
  if (a.locationId && a.locationId === b.locationId) return 1;
  // An unlocated complaint can neither confirm nor deny; it should not score as
  // "different building" and should not be rewarded either.
  if (!a.locationId || !b.locationId) return 0.2;

  const shared = new Set(b.locationAncestorIds);
  // The chain runs self → root, so the first hit is the deepest shared node.
  const index = a.locationAncestorIds.findIndex((id) => shared.has(id));
  if (index < 0) return 0;

  // Depth counted from the root: campus 0 · building 1 · floor 2 · room 3.
  const depth = a.locationAncestorIds.length - 1 - index;
  if (depth >= 2) return 0.7;
  if (depth === 1) return 0.5;
  return 0.1;
}

/**
 * Linear decay across the category's own window (`dedupWindowHours`). A burst
 * pipe reported twelve hours apart is two floods; a broken chair reported three
 * days apart is one chair — which is why the window is per-category rather than
 * a single global constant.
 */
export function timeProximity(aAt: Date, bAt: Date, windowHours: number): number {
  if (windowHours <= 0) return 0;
  const hoursApart = Math.abs(aAt.getTime() - bAt.getTime()) / 3_600_000;
  return round(Math.max(0, 1 - hoursApart / windowHours));
}

export function verdictFor(score: number): DedupVerdict {
  if (score >= AUTO_LINK_THRESHOLD) return 'AUTO_LINKED';
  if (score >= SUGGEST_THRESHOLD) return 'SUGGESTED';
  return 'NEW';
}

export function scoreCandidate(
  subject: DedupAttributes,
  candidate: DedupCandidate,
  windowHours: number,
): DedupScore {
  const parts: DedupParts = {
    signature: signatureMatch(subject, candidate),
    location: locationProximity(subject, candidate),
    text: clamp01(candidate.textSimilarity),
    time: timeProximity(subject.createdAt, candidate.createdAt, windowHours),
  };

  const score = round(
    parts.signature * WEIGHTS.signature +
      parts.location * WEIGHTS.location +
      parts.text * WEIGHTS.text +
      parts.time * WEIGHTS.time,
  );

  return { score, verdict: verdictFor(score), parts, explain: explain(parts, candidate) };
}

function explain(parts: DedupParts, candidate: DedupCandidate): string[] {
  const lines: string[] = [];

  if (parts.signature >= 1) lines.push(`same problem as ${candidate.complaintCode}`);
  else if (parts.signature >= 0.7) lines.push(`closely matching problem in ${candidate.complaintCode}`);
  else if (parts.signature > 0) lines.push(`related problem in ${candidate.complaintCode}`);
  else lines.push(`different category to ${candidate.complaintCode}`);

  if (parts.location >= 1) lines.push('same location');
  else if (parts.location >= 0.7) lines.push('same floor');
  else if (parts.location >= 0.5) lines.push('same building');
  else if (parts.location > 0.2) lines.push('same campus');
  else lines.push('location not comparable');

  if (parts.text >= 0.45) lines.push(`wording is ${pct(parts.text)} similar`);
  if (parts.time >= 0.5) lines.push('reported at nearly the same time');
  else if (parts.time > 0) lines.push('reported inside the same window');

  return lines;
}

/**
 * The best candidate wins, and ties break towards the *earlier* complaint so a
 * burst of near-simultaneous reports converges on one incident rather than
 * racing between two.
 */
export function bestMatch(
  subject: DedupAttributes,
  candidates: DedupCandidate[],
  windowHours: number,
): { candidate: DedupCandidate; result: DedupScore } | null {
  let best: { candidate: DedupCandidate; result: DedupScore } | null = null;

  for (const candidate of candidates) {
    const result = scoreCandidate(subject, candidate, windowHours);
    if (
      !best ||
      result.score > best.result.score ||
      (result.score === best.result.score &&
        candidate.createdAt.getTime() < best.candidate.createdAt.getTime())
    ) {
      best = { candidate, result };
    }
  }

  return best;
}

const round = (n: number) => Math.round(n * 100) / 100;
const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const pct = (n: number) => `${Math.round(n * 100)}%`;
