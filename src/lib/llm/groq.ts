import OpenAI from 'openai';
import type { LlmJsonRequest, LlmProvider, LlmTextRequest } from './provider';

/**
 * Groq is OpenAI-compatible, so the `openai` SDK works pointed at its base URL.
 *
 * Constraints that shaped this file (plan.MD §1):
 * - `response_format: json_schema` with `strict: true` is only supported on
 *   `openai/gpt-oss-20b` / `-120b`. Default model is the 20b.
 * - Strict mode requires every property `required` and `additionalProperties:
 *   false`, so extraction schemas use `"unknown"` sentinels, never optionals.
 * - `temperature: 0` — extraction should be reproducible.
 *
 * Nothing here throws. Timeout, 429, malformed JSON, a refusal, a bad key: all
 * become `null` and the caller runs the rules instead.
 */

const BASE_URL = 'https://api.groq.com/openai/v1';
const DEFAULT_MODEL = 'openai/gpt-oss-20b';
const TIMEOUT_MS = 4000;

export function groqApiKey(): string | null {
  const key = process.env.GROQ_API_KEY?.trim();
  return key ? key : null;
}

export function groqModel(): string {
  return process.env.GROQ_MODEL?.trim() || DEFAULT_MODEL;
}

export function createGroqProvider(apiKey: string, model = groqModel()): LlmProvider {
  const client = new OpenAI({
    apiKey,
    baseURL: BASE_URL,
    timeout: TIMEOUT_MS,
    maxRetries: 1,
  });

  async function complete(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    extra: Partial<OpenAI.Chat.ChatCompletionCreateParamsNonStreaming>,
    label: string,
  ): Promise<string | null> {
    const startedAt = Date.now();
    try {
      const response = await client.chat.completions.create({
        model,
        temperature: 0,
        // gpt-oss reasoning tokens are billed against max_completion_tokens, so a
        // chatty reasoning pass can consume the whole budget and return empty
        // content. Extraction and titles need no deliberation.
        ...(/^openai\/gpt-oss/.test(model) ? { reasoning_effort: 'low' as const } : {}),
        messages,
        ...extra,
      });
      const choice = response.choices[0];
      if (choice?.message.refusal) {
        warn(label, `refused: ${choice.message.refusal}`, startedAt);
        return null;
      }
      const content = choice?.message.content?.trim();
      if (!content) {
        warn(label, 'empty completion', startedAt);
        return null;
      }
      return content;
    } catch (error) {
      warn(label, error instanceof Error ? error.message : String(error), startedAt);
      return null;
    }
  }

  return {
    name: `groq:${model}`,
    available: true,

    async json<T>(request: LlmJsonRequest): Promise<T | null> {
      const content = await complete(
        [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
        {
          max_completion_tokens: 1200,
          response_format: {
            type: 'json_schema',
            json_schema: { name: request.name, strict: true, schema: request.schema },
          },
        },
        `json:${request.name}`,
      );
      if (!content) return null;

      try {
        return JSON.parse(content) as T;
      } catch {
        // Strict mode should make this impossible; treat it as unavailable anyway.
        warn(`json:${request.name}`, 'response was not valid JSON', Date.now());
        return null;
      }
    },

    async text(request: LlmTextRequest): Promise<string | null> {
      return complete(
        [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
        // Generous ceiling: reasoning tokens come out of this budget too.
        { max_completion_tokens: request.maxTokens ?? 400 },
        'text',
      );
    },
  };
}

function warn(label: string, message: string, startedAt: number) {
  console.warn(`[llm] ${label} degraded to rules after ${Date.now() - startedAt}ms: ${message}`);
}
