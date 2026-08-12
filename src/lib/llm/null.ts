import type { LlmProvider } from './provider';

/**
 * The no-key path. Everything returns null, so callers fall through to the
 * deterministic rules — the Layer 2 behaviour, unchanged.
 */
export const nullProvider: LlmProvider = {
  name: 'null',
  available: false,
  async json() {
    return null;
  },
  async text() {
    return null;
  },
};
