import { matchLocation, normalize, type ExtractOptions } from './rules';
import type { CategorySchema, Slot, SlotValues } from '../types';

/**
 * Prompt + JSON-schema construction and response mapping for LLM extraction.
 *
 * Deliberately pure — no `fetch`, no Prisma, no env. The provider call lives in
 * `extract/index.ts`, so everything decision-shaped in here is unit-testable and
 * the domain-layer rule in CLAUDE.md §5 holds.
 *
 * Two guards make an LLM answer safe to pre-fill:
 *  1. every enum value is checked against the slot's declared options, so a
 *     hallucinated value is dropped rather than shown to the student;
 *  2. locations come back as free-text *phrases* and are resolved to ids by the
 *     same conservative matcher the rules path uses.
 */

/** Strict mode forbids optional fields, so "nothing found" needs a sentinel. */
export const UNKNOWN = 'unknown';

/**
 * `media` slots can't be filled from text. Free-`text` slots are excluded too:
 * asked to fill "anything else worth adding?", the model echoes the whole report
 * back, which then shows up twice in the summary and the description. The raw
 * text is already persisted on the draft, and a student answering that question
 * directly still fills the slot through `addMessage`.
 */
export function extractableSlots(schema: CategorySchema): Slot[] {
  return schema.slots.filter((s) => s.type !== 'media' && s.type !== 'text');
}

type JsonSchema = Record<string, unknown>;

function propertyFor(slot: Slot): JsonSchema {
  const optionValues = (slot.options ?? []).map((o) => o.value);
  // Enum keys alone read as guesswork to the model — ONE_DAY vs MULTI_DAY was
  // getting decided by the key name. The student-facing labels are the meaning.
  const legend = (slot.options ?? []).map((o) => `${o.value} = ${o.label}`).join('; ');

  switch (slot.type) {
    case 'enum':
      return {
        type: 'string',
        enum: [...optionValues, UNKNOWN],
        description: `${slot.question} Meanings — ${legend}. Use "${UNKNOWN}" unless the report clearly indicates one of these.`,
      };
    case 'multi':
      return {
        type: 'array',
        items: { type: 'string', enum: optionValues },
        description: `${slot.question} Meanings — ${legend}. Include only values the report clearly indicates; use an empty array otherwise.`,
      };
    case 'boolean':
      return {
        type: 'string',
        enum: ['yes', 'no', UNKNOWN],
        description: `${slot.question} Use "${UNKNOWN}" unless the report answers this.`,
      };
    case 'location':
      return {
        type: 'string',
        description:
          'The place, quoted as closely as possible to how the reporter worded it (e.g. "CSE Block 2nd floor", "Boys Hostel A entrance"). Do not invent or normalise a place name. Use "unknown" if no place is mentioned.',
      };
    case 'number':
      return {
        type: 'string',
        description: `${slot.question} Digits only, or "${UNKNOWN}".`,
      };
    case 'date':
      return {
        type: 'string',
        description: `${slot.question} ISO date (YYYY-MM-DD), or "${UNKNOWN}".`,
      };
    case 'text':
    default:
      return {
        type: 'string',
        description: `${slot.question} Quote the reporter's own words; use "${UNKNOWN}" if they said nothing about it.`,
      };
  }
}

/**
 * Slot-set schema for one category. Every property is required and
 * `additionalProperties` is false — Groq strict mode accepts nothing less.
 */
export function buildExtractionSchema(schema: CategorySchema): { name: string; schema: JsonSchema } {
  const slots = extractableSlots(schema);
  const properties: Record<string, JsonSchema> = {};
  for (const slot of slots) properties[slot.key] = propertyFor(slot);

  return {
    name: `extract_${schema.key.toLowerCase()}`,
    schema: {
      type: 'object',
      properties,
      required: slots.map((s) => s.key),
      additionalProperties: false,
    },
  };
}

export function buildExtractionPrompt(
  schema: CategorySchema,
  text: string,
): { system: string; user: string } {
  return {
    system: [
      'You extract structured fields from a campus complaint. You do not classify severity, assign departments, or decide anything — only report what the text says.',
      `The complaint category is already known: ${schema.label}.`,
      'Fill a field only when the report states or plainly implies it. When in doubt use the "unknown" sentinel — a missing field costs one follow-up question, a wrong field misroutes the complaint.',
      'Read negation and contrast carefully: "everyone else is fine, only my laptop" means only the reporter is affected.',
      'Never copy an example value from a field description.',
    ].join('\n'),
    user: `Complaint report:\n"""\n${text.trim()}\n"""`,
  };
}

/** Category classification is a separate, cheap call — the slot set isn't known yet. */
export function buildCategorySchema(categoryKeys: string[]): { name: string; schema: JsonSchema } {
  return {
    name: 'classify_category',
    schema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: [...categoryKeys, UNKNOWN],
          description: 'The category the complaint belongs to, or "unknown" if none clearly fits.',
        },
      },
      required: ['category'],
      additionalProperties: false,
    },
  };
}

export function buildCategoryPrompt(
  categories: Pick<CategorySchema, 'key' | 'label' | 'description'>[],
  text: string,
): { system: string; user: string } {
  const list = categories.map((c) => `- ${c.key} (${c.label}): ${c.description}`).join('\n');
  return {
    system: [
      'You label a campus complaint with one category. Nothing else.',
      'Categories:',
      list,
      'Answer "unknown" if the report does not clearly belong to one of them — an unknown answer makes the system ask the student, which is far better than a wrong label.',
    ].join('\n'),
    user: `Complaint report:\n"""\n${text.trim()}\n"""`,
  };
}

export interface CategoryPayload {
  category: string;
}

/** Only a key that has a schema counts; anything else means "ask the student". */
export function readCategory(payload: unknown, availableKeys: string[]): string | null {
  const value = (payload as CategoryPayload | null)?.category;
  if (typeof value !== 'string' || value === UNKNOWN) return null;
  return availableKeys.includes(value) ? value : null;
}

/** LLM-extracted values sit below an explicit answer but above a keyword match. */
const LLM_CONFIDENCE = 0.8;
const LLM_LOCATION_CONFIDENCE = 0.7;

export interface MappedExtraction {
  slots: SlotValues;
  /** Kept for the timeline / debugging: what the model said before resolution. */
  locationPhrase: string | null;
  /** Field names the model returned that don't belong to the schema. */
  rejected: string[];
}

/**
 * Response → `SlotValues`. Anything unrecognised is dropped: an absent slot only
 * costs a question, whereas a bad pre-fill is shown to the student as fact.
 */
export function mapExtraction(
  schema: CategorySchema,
  payload: unknown,
  options: ExtractOptions = {},
): MappedExtraction {
  const out: SlotValues = {};
  const rejected: string[] = [];
  let locationPhrase: string | null = null;

  if (!payload || typeof payload !== 'object') {
    return { slots: out, locationPhrase, rejected };
  }
  const raw = payload as Record<string, unknown>;
  const byKey = new Map(schema.slots.map((s) => [s.key, s]));

  for (const [key, value] of Object.entries(raw)) {
    const slot = byKey.get(key);
    if (!slot) {
      rejected.push(key);
      continue;
    }
    if (isUnknown(value)) continue;

    if (slot.type === 'location') {
      const phrase = String(value).trim();
      if (!phrase) continue;
      locationPhrase = phrase;
      const match = matchLocation(normalize(phrase), options.locations ?? []);
      if (match) {
        out[key] = {
          value: match.id,
          state: 'FILLED',
          source: 'EXTRACTED',
          confidence: LLM_LOCATION_CONFIDENCE,
        };
      }
      continue;
    }

    const mapped = coerce(slot, value);
    if (mapped === undefined) {
      rejected.push(key);
      continue;
    }
    out[key] = { value: mapped, state: 'FILLED', source: 'EXTRACTED', confidence: LLM_CONFIDENCE };
  }

  return { slots: out, locationPhrase, rejected };
}

function isUnknown(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    return v === '' || v === UNKNOWN || v === 'null' || v === 'n/a' || v === 'none stated';
  }
  return false;
}

/** `undefined` = the model returned something this slot cannot hold. */
function coerce(slot: Slot, value: unknown): unknown | undefined {
  const allowed = slot.options?.map((o) => o.value);

  switch (slot.type) {
    case 'enum': {
      const v = String(value);
      return allowed?.includes(v) ? v : undefined;
    }
    case 'multi': {
      if (!Array.isArray(value)) return undefined;
      const kept = value.map(String).filter((v) => allowed?.includes(v));
      return kept.length > 0 ? kept : undefined;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      const v = String(value).trim().toLowerCase();
      if (v === 'yes' || v === 'true') return true;
      if (v === 'no' || v === 'false') return false;
      return undefined;
    }
    case 'number': {
      const n = Number(String(value).replace(/[^0-9.-]/g, ''));
      return Number.isFinite(n) ? n : undefined;
    }
    case 'text':
    case 'date':
      return String(value).trim();
    default:
      return undefined;
  }
}
