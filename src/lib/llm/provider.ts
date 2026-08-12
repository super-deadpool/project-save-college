/**
 * The LLM boundary. Two capabilities only (plan.MD §2): structured **extraction**
 * and **prose**. No provider method returns a decision — priority, routing,
 * dedup and transitions are deterministic code elsewhere.
 *
 * Every method resolves to `null` instead of throwing. A null means "the LLM had
 * nothing for you" and the caller degrades to the rules path; that contract is
 * what keeps the whole system working with `GROQ_API_KEY` unset.
 */

export interface LlmJsonRequest {
  system: string;
  user: string;
  /** Schema name sent to the provider; useful in provider-side logs. */
  name: string;
  /** JSON Schema. Must satisfy Groq strict mode: every property required, `additionalProperties: false`. */
  schema: Record<string, unknown>;
}

export interface LlmTextRequest {
  system: string;
  user: string;
  maxTokens?: number;
}

export interface LlmProvider {
  readonly name: string;
  /** False for the null provider — lets callers skip prompt building entirely. */
  readonly available: boolean;
  json<T>(request: LlmJsonRequest): Promise<T | null>;
  text(request: LlmTextRequest): Promise<string | null>;
}
