import { describe, expect, it, vi } from 'vitest';
import { electricalSchema, networkSchema } from '@/lib/engine/schemas';
import {
  buildCategorySchema,
  buildExtractionSchema,
  mapExtraction,
  readCategory,
  UNKNOWN,
} from '@/lib/engine/extract/llm';
import { extractFromText, extractWithLlm } from '@/lib/engine/extract';
import { applyAnswer, emptyDraft, mergeExtracted, nextStep } from '@/lib/engine/draft';
import { nullProvider } from '@/lib/llm/null';
import type { LlmProvider } from '@/lib/llm/provider';
import type { CategorySchema, DraftState } from '@/lib/engine/types';

const LOCATIONS = [
  { id: 'loc-cse', name: 'CSE Block' },
  { id: 'loc-hostel-a', name: 'Boys Hostel A' },
  { id: 'loc-lab', name: 'CSE Programming Lab 1' },
];

/** A provider that returns a canned payload per schema name. */
function fakeProvider(payloads: Record<string, unknown>, text?: string | null): LlmProvider {
  return {
    name: 'fake',
    available: true,
    async json({ name }) {
      return (payloads[name] ?? null) as never;
    },
    async text() {
      return text ?? null;
    },
  };
}

describe('extraction JSON schema (Groq strict mode)', () => {
  const built = buildExtractionSchema(electricalSchema);

  it('marks every property required and forbids extras', () => {
    const properties = Object.keys(built.schema.properties as object);
    expect(built.schema.required).toEqual(properties);
    expect(built.schema.additionalProperties).toBe(false);
    expect(properties.length).toBeGreaterThan(0);
  });

  it('gives enum and boolean slots an "unknown" sentinel instead of being optional', () => {
    const props = built.schema.properties as Record<string, { enum?: string[] }>;
    expect(props.problem_type.enum).toContain(UNKNOWN);
    expect(props.problem_type.enum).toContain('EXPOSED_WIRING');
    expect(props.person_at_risk.enum).toEqual(['yes', 'no', UNKNOWN]);
  });

  it('describes multi slots as an array constrained to the declared options', () => {
    const props = built.schema.properties as Record<string, { type: string; items?: { enum: string[] } }>;
    expect(props.safety_hazard.type).toBe('array');
    expect(props.safety_hazard.items?.enum).toEqual([
      'SMOKE',
      'BURNING_SMELL',
      'SPARKING',
      'EXPOSED_WIRE',
      'SHOCK',
      'NONE',
    ]);
    // The empty array — not a missing field — is how the model says nothing.
    expect(props.safety_hazard.items?.enum).not.toContain(UNKNOWN);
  });

  it('omits free-text slots, which the model just fills with the report itself', () => {
    const props = Object.keys(built.schema.properties as object);
    expect(props).not.toContain('details');
    expect(props).toContain('problem_type');
  });

  it('omits media slots, which text cannot fill', () => {
    const schema: CategorySchema = {
      ...networkSchema,
      slots: [...networkSchema.slots, { key: 'photo', question: 'Photo?', type: 'media', importance: 'OPTIONAL', infoGain: 0.1 }],
    };
    expect(Object.keys(buildExtractionSchema(schema).schema.properties as object)).not.toContain('photo');
  });

  it('builds a category schema over the categories that actually have slots', () => {
    const built = buildCategorySchema(['NETWORK', 'ELECTRICAL']);
    const props = built.schema.properties as Record<string, { enum: string[] }>;
    expect(props.category.enum).toEqual(['NETWORK', 'ELECTRICAL', UNKNOWN]);
    expect(built.schema.required).toEqual(['category']);
  });
});

describe('mapping a response onto slots', () => {
  it('accepts declared enum, multi and boolean values', () => {
    const { slots } = mapExtraction(electricalSchema, {
      safety_hazard: ['EXPOSED_WIRE'],
      person_at_risk: 'yes',
      problem_type: 'EXPOSED_WIRING',
      location: UNKNOWN,
      scope: UNKNOWN,
      duration: 'TODAY',
      impact: UNKNOWN,
      details: UNKNOWN,
    });

    expect(slots.safety_hazard).toMatchObject({ value: ['EXPOSED_WIRE'], state: 'FILLED', source: 'EXTRACTED' });
    expect(slots.person_at_risk.value).toBe(true);
    expect(slots.problem_type.value).toBe('EXPOSED_WIRING');
    expect(slots.duration.value).toBe('TODAY');
    // "unknown" must not become a value — it has to leave the slot askable.
    expect(slots.scope).toBeUndefined();
    expect(slots.impact).toBeUndefined();
    expect(slots.details).toBeUndefined();
  });

  it('drops a hallucinated enum value rather than pre-filling it', () => {
    const { slots, rejected } = mapExtraction(electricalSchema, {
      problem_type: 'GENERATOR_FAILURE',
      safety_hazard: ['METEOR'],
    });
    expect(slots.problem_type).toBeUndefined();
    expect(slots.safety_hazard).toBeUndefined();
    expect(rejected).toEqual(['problem_type', 'safety_hazard']);
  });

  it('reports fields that do not belong to the schema at all', () => {
    const { slots, rejected } = mapExtraction(networkSchema, { made_up_slot: 'x', duration: 'TODAY' });
    expect(rejected).toEqual(['made_up_slot']);
    expect(slots.duration.value).toBe('TODAY');
  });

  it('keeps only the option values the model got right in a multi slot', () => {
    const { slots } = mapExtraction(electricalSchema, { safety_hazard: ['SMOKE', 'FLOOD'] });
    expect(slots.safety_hazard.value).toEqual(['SMOKE']);
  });

  it('resolves a location phrase through the deterministic matcher', () => {
    const { slots, locationPhrase } = mapExtraction(
      networkSchema,
      { location: 'the 2nd floor of CSE Block' },
      { locations: LOCATIONS },
    );
    expect(locationPhrase).toBe('the 2nd floor of CSE Block');
    expect(slots.location).toMatchObject({ value: 'loc-cse', source: 'EXTRACTED' });
  });

  it('leaves the location unfilled when no seeded place matches the phrase', () => {
    const { slots, locationPhrase } = mapExtraction(
      networkSchema,
      { location: 'somewhere near the north gate' },
      { locations: LOCATIONS },
    );
    expect(locationPhrase).toBe('somewhere near the north gate');
    expect(slots.location).toBeUndefined();
  });

  it('survives a payload that is not an object', () => {
    expect(mapExtraction(networkSchema, 'nope').slots).toEqual({});
    expect(mapExtraction(networkSchema, null).slots).toEqual({});
  });
});

describe('category verdict', () => {
  it('accepts a known key and rejects unknown or invented ones', () => {
    const keys = ['NETWORK', 'ELECTRICAL'];
    expect(readCategory({ category: 'ELECTRICAL' }, keys)).toBe('ELECTRICAL');
    expect(readCategory({ category: UNKNOWN }, keys)).toBeNull();
    expect(readCategory({ category: 'PARKING' }, keys)).toBeNull();
    expect(readCategory(null, keys)).toBeNull();
  });
});

describe('extractWithLlm — the hybrid contract', () => {
  const text = 'There is exposed electrical wiring near the entrance of Boys Hostel A';

  it('degrades to the rules result when no provider is available', async () => {
    const withLlm = await extractWithLlm(text, null, { locations: LOCATIONS }, nullProvider);
    const rulesOnly = extractFromText(text, null, { locations: LOCATIONS });
    expect(withLlm).toEqual(rulesOnly);
    expect(withLlm.source).toBe('RULES');
  });

  it('degrades to the rules result when the provider returns nothing', async () => {
    const provider = fakeProvider({});
    const result = await extractWithLlm(text, null, { locations: LOCATIONS }, provider);
    expect(result.source).toBe('RULES');
    expect(result.slots).toEqual(extractFromText(text, null, { locations: LOCATIONS }).slots);
  });

  it('classifies with the LLM when keywords could not', async () => {
    const vague = 'nobody in my wing can get online since last night';
    expect(extractFromText(vague, null).categoryKey).toBeNull();

    const provider = fakeProvider({
      classify_category: { category: 'NETWORK' },
      extract_network: {
        problem_type: 'NO_CONNECTION',
        location: UNKNOWN,
        scope: 'MANY',
        duration: 'ONE_DAY',
        impact: UNKNOWN,
        device_type: UNKNOWN,
        other_networks_work: UNKNOWN,
        details: UNKNOWN,
      },
    });

    const result = await extractWithLlm(vague, null, { locations: LOCATIONS }, provider);
    expect(result.categoryKey).toBe('NETWORK');
    expect(result.source).toBe('LLM');
    expect(result.slots.scope.value).toBe('MANY');
  });

  it('still returns rules slots when classification succeeds but extraction fails', async () => {
    const provider = fakeProvider({ classify_category: { category: 'ELECTRICAL' } });
    const result = await extractWithLlm('the wiring is hanging loose in CSE Block', null, { locations: LOCATIONS }, provider);
    expect(result.categoryKey).toBe('ELECTRICAL');
    expect(result.source).toBe('RULES');
    expect(result.slots.location.value).toBe('loc-cse');
  });

  it('lets the LLM win a conflict and lets the rules fill its gaps', async () => {
    // Keyword matching reads "everyone" as MANY; the sentence says the opposite.
    const contrast = 'wifi keeps disconnecting on my laptop in CSE Block, everyone else is fine';
    const rules = extractFromText(contrast, networkSchema, { locations: LOCATIONS });
    expect(rules.slots.scope.value).toBe('MANY');

    const provider = fakeProvider({
      extract_network: {
        problem_type: 'KEEPS_DISCONNECTING',
        location: 'CSE Block',
        scope: 'ONLY_ME',
        duration: UNKNOWN,
        impact: UNKNOWN,
        device_type: UNKNOWN,
        other_networks_work: UNKNOWN,
        details: UNKNOWN,
      },
    });

    const result = await extractWithLlm(contrast, networkSchema, { locations: LOCATIONS }, provider);
    expect(result.slots.scope.value).toBe('ONLY_ME');
    // device_type came back "unknown" but the rules matched "laptop" literally.
    expect(result.slots.device_type.value).toBe('LAPTOP');
  });

  it('skips the provider entirely for empty text', async () => {
    const json = vi.fn();
    const provider: LlmProvider = { name: 'spy', available: true, json, async text() { return null; } };
    await extractWithLlm('   ', networkSchema, {}, provider);
    expect(json).not.toHaveBeenCalled();
  });
});

/**
 * Count the questions the engine would ask, given an extraction result. Answers
 * deliberately avoid `criticalValues` — a critical answer short-circuits the
 * conversation and would make both paths look equally short.
 */
function questionsAsked(schema: CategorySchema, initial: DraftState): string[] {
  const asked: string[] = [];
  let state = initial;
  for (let i = 0; i < 12; i++) {
    const step = nextStep(schema, state);
    if (step.kind !== 'QUESTION') return asked;
    const slot = step.slot;
    asked.push(slot.key);

    const critical = slot.criticalValues ?? [];
    const benign = slot.options?.find((o) => !critical.includes(o.value))?.value;
    const value =
      slot.type === 'boolean'
        ? false
        : slot.type === 'multi'
          ? [benign ?? 'NONE']
          : slot.type === 'location'
            ? 'loc-cse'
            : (benign ?? 'x');
    state = applyAnswer(schema, state, slot.key, { kind: 'VALUE', value });
  }
  throw new Error('Conversation did not terminate');
}

describe('Layer 3 gate: LLM extraction shortens the conversation', () => {
  const text = 'There is exposed electrical wiring near the entrance of Boys Hostel A';

  it('asks at least 3 fewer questions than the rules path on the same sentence', async () => {
    const provider = fakeProvider({
      classify_category: { category: 'ELECTRICAL' },
      extract_electrical: {
        safety_hazard: ['EXPOSED_WIRE'],
        person_at_risk: 'yes',
        problem_type: 'EXPOSED_WIRING',
        location: 'the entrance of Boys Hostel A',
        scope: 'FEW',
        duration: UNKNOWN,
        impact: UNKNOWN,
        details: UNKNOWN,
      },
    });

    const rules = extractFromText(text, null, { locations: LOCATIONS });
    const llm = await extractWithLlm(text, null, { locations: LOCATIONS }, provider);
    expect(llm.source).toBe('LLM');

    const rulesAsked = questionsAsked(
      electricalSchema,
      mergeExtracted(electricalSchema, emptyDraft(text), rules.slots),
    );
    const llmAsked = questionsAsked(
      electricalSchema,
      mergeExtracted(electricalSchema, emptyDraft(text), llm.slots),
    );

    expect(rulesAsked.length - llmAsked.length).toBeGreaterThanOrEqual(3);
    // The safety questions are the ones the LLM answered from the sentence.
    expect(llmAsked).not.toContain('safety_hazard');
    expect(llmAsked).not.toContain('person_at_risk');
    expect(llmAsked).not.toContain('location');
  });
});
