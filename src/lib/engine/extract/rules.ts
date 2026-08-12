import { CATEGORY_SCHEMAS, getCategory } from '../schemas';
import type { CategorySchema, SlotValues } from '../types';

/**
 * Keyword extraction — the Layer 2 baseline. It never guesses beyond a literal
 * phrase match, so its output is safe to pre-fill. Layer 3 puts an LLM in front
 * of this; when the LLM is unavailable this is what runs.
 */

export interface LocationHint {
  id: string;
  name: string;
  /** Extra phrases that identify the location (codes, room numbers). */
  aliases?: string[];
}

export function normalize(text: string): string {
  return ` ${text
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;
}

function contains(haystack: string, phrase: string): boolean {
  const needle = normalize(phrase).trim();
  return needle.length > 0 && haystack.includes(` ${needle} `);
}

/** Exported so tests can assert schema hints against the real list, not a copy. */
export const NEGATORS = new Set([
  'no', 'not', 'nothing', 'none', 'never', 'without', 'isnt', 'arent', 'wasnt',
  'werent', 'dont', 'doesnt', 'didnt', 'cannot', 'cant', 'nobody', 'neither', 'nor',
]);

/** "nothing sparking or smoking" reaches three tokens back to the negator. */
const NEGATION_WINDOW = 3;

/**
 * Hint matching that respects negation. Without this, "nothing sparking or
 * smoking" fills the safety slot with SMOKE + SPARKING, which trips the
 * short-circuit and submits a routine power cut as CRITICAL.
 *
 * A hint that is itself phrased negatively ("no internet", "cant log in",
 * "nobody can") is never suppressed — the negator belongs to the hint.
 */
export function hintMatches(haystack: string, phrase: string): boolean {
  const needle = normalize(phrase).trim();
  if (!needle) return false;
  if (NEGATORS.has(needle.split(' ')[0])) return haystack.includes(` ${needle} `);

  const target = ` ${needle} `;
  for (let from = 0; ; ) {
    const at = haystack.indexOf(target, from);
    if (at === -1) return false;
    const preceding = haystack.slice(0, at + 1).trim().split(' ').filter(Boolean);
    // One un-negated occurrence is enough.
    if (!preceding.slice(-NEGATION_WINDOW).some((w) => NEGATORS.has(w))) return true;
    from = at + 1;
  }
}

export interface CategoryGuess {
  categoryKey: string;
  confidence: number;
  matched: string[];
}

/** Best-matching category by keyword hits, or null when nothing matches. */
export function extractCategory(text: string): CategoryGuess | null {
  const normalized = normalize(text);
  const guesses: CategoryGuess[] = [];

  for (const schema of CATEGORY_SCHEMAS) {
    const matched = schema.keywords.filter((k) => contains(normalized, k));
    // Option hints are strong category evidence too ("sparking" ⇒ electrical) —
    // but only from slots that describe the *problem*. Scope, impact and duration
    // are circumstances every category shares, so "my wing" or "since yesterday"
    // must not cast a vote for whichever category happens to word them that way.
    const optionHits = schema.slots
      .filter((s) => !s.signal)
      .flatMap((s) =>
        (s.options ?? []).flatMap((o) => (o.hints ?? []).filter((h) => contains(normalized, h))),
      );
    const hits = matched.length + optionHits.length;
    if (hits === 0) continue;
    guesses.push({
      categoryKey: schema.key,
      confidence: Math.min(0.95, 0.5 + 0.15 * hits),
      matched: [...matched, ...optionHits],
    });
  }

  if (guesses.length === 0) return null;
  guesses.sort((a, b) => b.confidence - a.confidence || b.matched.length - a.matched.length);

  // Two categories matching equally well is not a guess worth making.
  if (guesses.length > 1 && guesses[0].matched.length === guesses[1].matched.length) {
    return { ...guesses[0], confidence: Math.min(guesses[0].confidence, 0.45) };
  }
  return guesses[0];
}

export interface ExtractOptions {
  locations?: LocationHint[];
}

/**
 * Pull slot values out of free text. Only enum/multi option hints and location
 * names are matched — nothing is inferred.
 */
export function extractSlots(
  schemaOrKey: CategorySchema | string,
  text: string,
  options: ExtractOptions = {},
): SlotValues {
  const schema = typeof schemaOrKey === 'string' ? getCategory(schemaOrKey) : schemaOrKey;
  if (!schema) return {};

  const normalized = normalize(text);
  const out: SlotValues = {};

  for (const slot of schema.slots) {
    if (slot.type === 'location') {
      const match = matchLocation(normalized, options.locations ?? []);
      if (match) {
        out[slot.key] = { value: match.id, state: 'FILLED', source: 'EXTRACTED', confidence: 0.7 };
      }
      continue;
    }

    if (!slot.options) continue;

    const hits = slot.options.filter((o) =>
      (o.hints ?? []).some((h) => hintMatches(normalized, h)),
    );
    if (hits.length === 0) continue;

    if (slot.type === 'multi') {
      out[slot.key] = {
        value: hits.map((h) => h.value),
        state: 'FILLED',
        source: 'EXTRACTED',
        confidence: 0.75,
      };
    } else if (hits.length === 1) {
      // Ambiguous enum text is left for the question rather than guessed.
      out[slot.key] = {
        value: hits[0].value,
        state: 'FILLED',
        source: 'EXTRACTED',
        confidence: 0.75,
      };
    }
  }

  return out;
}

/**
 * Conservative: every significant word of the location name must appear, so
 * "hostel" alone does not resolve to one of three hostels.
 *
 * Exported because the LLM path reuses it: the model returns a location *phrase*
 * and this deterministic matcher turns it into an id (plan.MD Layer 3) — the
 * model never picks a database row.
 */
export function matchLocation(normalized: string, locations: LocationHint[]): LocationHint | null {
  const stop = new Set(['the', 'of', 'and', 'block', 'floor', 'room', 'st', 'nd', 'rd', 'th']);
  let best: { loc: LocationHint; score: number } | null = null;

  for (const loc of locations) {
    for (const alias of [loc.name, ...(loc.aliases ?? [])]) {
      const words = normalize(alias).trim().split(' ').filter((w) => w && !stop.has(w));
      if (words.length === 0) continue;
      if (!words.every((w) => normalized.includes(` ${w} `))) continue;
      const score = words.join('').length;
      if (!best || score > best.score) best = { loc, score };
    }
  }

  return best?.loc ?? null;
}
