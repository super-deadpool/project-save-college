import { extractCategory, extractSlots, type ExtractOptions, type LocationHint } from './rules';
import {
  buildCategoryPrompt,
  buildCategorySchema,
  buildExtractionPrompt,
  buildExtractionSchema,
  mapExtraction,
  readCategory,
} from './llm';
import { CATEGORY_SCHEMAS, getCategory } from '../schemas';
import type { CategorySchema, SlotValues } from '../types';
import type { LlmProvider } from '@/lib/llm/provider';

/**
 * Extraction entry point.
 *
 * `extractFromText` is the deterministic Layer 2 path and stays synchronous —
 * it is the fallback and the no-key behaviour. `extractWithLlm` wraps it: rules
 * run first regardless, then the LLM refines. Any failure leaves the rules
 * result exactly as Layer 2 produced it.
 */
export interface ExtractionResult {
  categoryKey: string | null;
  categoryConfidence: number;
  slots: SlotValues;
  source: 'RULES' | 'LLM';
}

/** Below this the student is asked to pick the category instead. */
export const CATEGORY_CONFIDENCE_THRESHOLD = 0.6;

/** An LLM category label is trusted more than a keyword hit, but not blindly. */
const LLM_CATEGORY_CONFIDENCE = 0.85;

export function extractFromText(
  text: string,
  schema: CategorySchema | null,
  options: ExtractOptions = {},
): ExtractionResult {
  let resolved = schema;
  let confidence = schema ? 1 : 0;

  if (!resolved) {
    const guess = extractCategory(text);
    if (guess && guess.confidence >= CATEGORY_CONFIDENCE_THRESHOLD) {
      resolved = getCategory(guess.categoryKey);
      confidence = guess.confidence;
    } else if (guess) {
      confidence = guess.confidence;
    }
  }

  return {
    categoryKey: resolved?.key ?? null,
    categoryConfidence: confidence,
    slots: resolved ? extractSlots(resolved, text, options) : {},
    source: 'RULES',
  };
}

/**
 * Rules + LLM. Where both have an opinion the LLM wins: it reads negation and
 * contrast ("everyone else is fine, only mine") that keyword matching gets
 * backwards. Where the LLM says "unknown", a rules hit still stands.
 *
 * When the category is unknown this costs two calls — the slot set isn't known
 * until the category is, so classification can't share the schema.
 */
export async function extractWithLlm(
  text: string,
  schema: CategorySchema | null,
  options: ExtractOptions = {},
  provider?: LlmProvider,
): Promise<ExtractionResult> {
  const rules = extractFromText(text, schema, options);
  if (!provider?.available || !text.trim()) return rules;

  let resolved = schema;
  let categoryConfidence = rules.categoryConfidence;

  if (!resolved) {
    const payload = await provider.json<unknown>({
      ...buildCategorySchema(CATEGORY_SCHEMAS.map((c) => c.key)),
      ...buildCategoryPrompt(CATEGORY_SCHEMAS, text),
    });
    const key = readCategory(payload, CATEGORY_SCHEMAS.map((c) => c.key));
    if (key) {
      resolved = getCategory(key);
      categoryConfidence = LLM_CATEGORY_CONFIDENCE;
    } else {
      // No LLM verdict — keep whatever the keyword guess produced.
      resolved = getCategory(rules.categoryKey);
    }
  }

  if (!resolved) return { ...rules, categoryConfidence };

  // The category may have been discovered above, so rerun the rules against the
  // now-known slot set rather than reusing a category-less result.
  const baseline =
    resolved.key === rules.categoryKey ? rules.slots : extractSlots(resolved, text, options);

  const payload = await provider.json<unknown>({
    ...buildExtractionSchema(resolved),
    ...buildExtractionPrompt(resolved, text),
  });
  if (!payload) {
    return {
      categoryKey: resolved.key,
      categoryConfidence,
      slots: baseline,
      source: 'RULES',
    };
  }

  const mapped = mapExtraction(resolved, payload, options);
  if (mapped.rejected.length > 0) {
    console.warn(`[llm] dropped unusable extraction fields: ${mapped.rejected.join(', ')}`);
  }

  return {
    categoryKey: resolved.key,
    categoryConfidence,
    slots: { ...baseline, ...mapped.slots },
    source: 'LLM',
  };
}

export { extractCategory, extractSlots };
export type { ExtractOptions, LocationHint };
