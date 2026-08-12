import { buildTitle, summaryLines } from '@/lib/engine/summary';
import type { CategorySchema, SlotValues } from '@/lib/engine/types';
import type { LlmProvider } from './provider';

/**
 * Prose only (plan.MD §2) — the title is a label for staff to scan, it decides
 * nothing. `buildTitle` remains the fallback, so no-key runs are unaffected.
 */

const MAX_TITLE = 90;

/** Trims the model's habits: quotes, trailing period, "Title:" prefix, rambling. */
export function sanitizeTitle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let title = raw
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!title) return null;

  title = title
    .replace(/^(title|complaint)\s*[:\-–]\s*/i, '')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.\s]+$/, '')
    .trim();

  if (title.length < 6) return null;
  if (title.length > MAX_TITLE) return null; // a paragraph, not a title
  return title;
}

export async function generateTitle(
  provider: LlmProvider,
  schema: CategorySchema,
  slots: SlotValues,
  locationName: string | null | undefined,
  rawText: string,
): Promise<string> {
  const fallback = buildTitle(schema, slots, locationName);
  if (!provider.available) return fallback;

  const facts = summaryLines(schema, slots, locationName)
    .map((l) => `${l.label}: ${l.display}`)
    .join('\n');

  const text = await provider.text({
    system: [
      'You write the one-line title of a campus complaint ticket, for staff scanning a queue.',
      'Rules: under 80 characters, no quotes, no trailing period, no invented detail, no urgency words unless the facts state one.',
      'Lead with the problem, then the place. Output the title and nothing else.',
    ].join('\n'),
    user: `Category: ${schema.label}\n${facts}\n\nReported as: "${rawText.trim()}"`,
    maxTokens: 300,
  });

  return sanitizeTitle(text) ?? fallback;
}
