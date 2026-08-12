import { createGroqProvider, groqApiKey, groqModel } from './groq';
import { nullProvider } from './null';
import type { LlmProvider } from './provider';

let cached: { key: string; provider: LlmProvider } | null = null;

/**
 * The single place the app decides whether an LLM is in play. No key → the null
 * provider, and every caller silently runs on rules.
 */
export function getLlmProvider(): LlmProvider {
  const key = groqApiKey();
  if (!key) return nullProvider;

  const cacheKey = `${key}:${groqModel()}`;
  if (cached?.key !== cacheKey) {
    cached = { key: cacheKey, provider: createGroqProvider(key) };
  }
  return cached.provider;
}

export { nullProvider, createGroqProvider, groqApiKey, groqModel };
export type { LlmProvider };
export type { LlmJsonRequest, LlmTextRequest } from './provider';
