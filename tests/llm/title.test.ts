import { describe, expect, it } from 'vitest';
import { generateTitle, sanitizeTitle } from '@/lib/llm/title';
import { buildTitle } from '@/lib/engine/summary';
import { electricalSchema } from '@/lib/engine/schemas';
import { nullProvider } from '@/lib/llm/null';
import type { LlmProvider } from '@/lib/llm/provider';
import type { SlotValues } from '@/lib/engine/types';

const SLOTS: SlotValues = {
  problem_type: { value: 'EXPOSED_WIRING', state: 'FILLED', source: 'EXTRACTED', confidence: 0.8 },
  safety_hazard: { value: ['EXPOSED_WIRE'], state: 'FILLED', source: 'EXTRACTED', confidence: 0.8 },
  person_at_risk: { value: true, state: 'FILLED', source: 'ANSWERED', confidence: 1 },
};

function textProvider(text: string | null): LlmProvider {
  return {
    name: 'fake',
    available: true,
    async json() {
      return null;
    },
    async text() {
      return text;
    },
  };
}

describe('sanitizeTitle', () => {
  it('strips quotes, a "Title:" prefix and the trailing period', () => {
    expect(sanitizeTitle('"Exposed wiring at Boys Hostel A entrance."')).toBe(
      'Exposed wiring at Boys Hostel A entrance',
    );
    expect(sanitizeTitle('Title: Fan not working in Room 214')).toBe('Fan not working in Room 214');
  });

  it('takes the first non-empty line and collapses whitespace', () => {
    expect(sanitizeTitle('\n\n  No power   on 2nd floor \nsome rambling after')).toBe(
      'No power on 2nd floor',
    );
  });

  it('rejects empty, stubby and paragraph-length output', () => {
    expect(sanitizeTitle('')).toBeNull();
    expect(sanitizeTitle(null)).toBeNull();
    expect(sanitizeTitle('ok')).toBeNull();
    expect(sanitizeTitle('x'.repeat(200))).toBeNull();
  });
});

describe('generateTitle', () => {
  it('falls back to the deterministic title with no provider', async () => {
    const title = await generateTitle(nullProvider, electricalSchema, SLOTS, 'Boys Hostel A', 'raw');
    expect(title).toBe(buildTitle(electricalSchema, SLOTS, 'Boys Hostel A'));
  });

  it('falls back when the provider returns nothing usable', async () => {
    const expected = buildTitle(electricalSchema, SLOTS, 'Boys Hostel A');
    expect(await generateTitle(textProvider(null), electricalSchema, SLOTS, 'Boys Hostel A', 'raw')).toBe(expected);
    expect(await generateTitle(textProvider('   '), electricalSchema, SLOTS, 'Boys Hostel A', 'raw')).toBe(expected);
    expect(await generateTitle(textProvider('x'.repeat(300)), electricalSchema, SLOTS, 'Boys Hostel A', 'raw')).toBe(expected);
  });

  it('uses the model title when it is usable', async () => {
    const title = await generateTitle(
      textProvider('Exposed live wiring at Boys Hostel A entrance'),
      electricalSchema,
      SLOTS,
      'Boys Hostel A',
      'there is exposed wiring near the hostel entrance',
    );
    expect(title).toBe('Exposed live wiring at Boys Hostel A entrance');
  });
});
