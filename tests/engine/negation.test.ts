import { describe, expect, it } from 'vitest';
import { electricalSchema, networkSchema } from '@/lib/engine/schemas';
import { extractSlots, hintMatches, normalize } from '@/lib/engine/extract/rules';
import { evaluateCompleteness, hasSafetyShortCircuit } from '@/lib/engine/completeness';

const LOCATIONS = [{ id: 'loc-hostel-a', name: 'Boys Hostel A' }];

describe('hintMatches — negation guard on the rules extractor', () => {
  const h = (text: string, phrase: string) => hintMatches(normalize(text), phrase);

  it('suppresses a hint the sentence explicitly denies', () => {
    expect(h('nothing sparking or smoking', 'sparking')).toBe(false);
    expect(h('nothing sparking or smoking', 'smoking')).toBe(false);
    expect(h('there is no burning smell', 'burning smell')).toBe(false);
    expect(h('the fan is not working, without any sparks', 'spark')).toBe(false);
  });

  it('keeps a plain assertion', () => {
    expect(h('smoke coming from the switch board', 'smoke')).toBe(true);
    expect(h('the socket is sparking', 'sparking')).toBe(true);
  });

  it('never suppresses a hint that is itself negative', () => {
    expect(h('there is no internet in my room', 'no internet')).toBe(true);
    expect(h('i cant log in to the portal', 'cant log in')).toBe(true);
    expect(h('nobody can connect', 'nobody can')).toBe(true);
  });

  it('accepts the sentence when one occurrence is un-negated', () => {
    expect(h('no sparking yesterday but the socket is sparking now', 'sparking')).toBe(true);
  });

  it('does not reach past the window into an unrelated clause', () => {
    expect(h('no power since morning and the whole floor is affected', 'whole floor')).toBe(true);
  });
});

describe('the bug this fixes', () => {
  const text =
    'No power in the whole of Boys Hostel A since yesterday, nothing sparking or smoking, and I have an exam tomorrow';

  it('no longer reports a safety hazard the student ruled out', () => {
    const slots = extractSlots(electricalSchema, text, { locations: LOCATIONS });
    expect(slots.safety_hazard).toBeUndefined();
    expect(hasSafetyShortCircuit(electricalSchema, slots)).toBe(false);
    // The engine now asks the safety question instead of assuming the answer.
    const completeness = evaluateCompleteness(electricalSchema, { slots, askedSlots: [] });
    expect(completeness.nextSlot?.key).toBe('safety_hazard');
  });

  it('still extracts everything the sentence does assert', () => {
    const slots = extractSlots(electricalSchema, text, { locations: LOCATIONS });
    expect(slots.problem_type.value).toBe('NO_POWER');
    expect(slots.location.value).toBe('loc-hostel-a');
    expect(slots.duration.value).toBe('ONE_DAY');
    expect(slots.impact.value).toBe('EXAM');
  });

  it('leaves the Layer 2 safety gate intact', () => {
    const slots = extractSlots(
      electricalSchema,
      'smoke coming from the switch board in Boys Hostel A',
      { locations: LOCATIONS },
    );
    expect(slots.safety_hazard.value).toEqual(['SMOKE']);
    expect(hasSafetyShortCircuit(electricalSchema, slots)).toBe(true);
  });

  it('leaves negatively-phrased network hints working', () => {
    const slots = extractSlots(networkSchema, 'there is no internet in CSE Block', {});
    expect(slots.problem_type.value).toBe('NO_CONNECTION');
  });
});
