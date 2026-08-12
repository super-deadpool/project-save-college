import type { Slot, SlotOption } from '../types';

/**
 * The rubric's shared signals worded per category (spec §8 — every category has
 * its own conversation) but normalised onto one vocabulary. A category composes
 * these with its own wording rather than restating the option sets, so
 * `classify.ts` can read scope/impact/duration from any of the 13 categories.
 */

export const SCOPE_OPTIONS: SlotOption[] = [
  { value: 'ONLY_ME', label: 'Only me', hints: ['only me', 'just me', 'only my', 'just my'] },
  { value: 'FEW', label: 'A few people', hints: ['few of us', 'couple of us', 'some of us', 'few rooms'] },
  { value: 'MANY', label: 'Many people here', hints: ['everyone', 'all of us', 'many people', 'nobody can', 'whole floor', 'entire floor'] },
  { value: 'BUILDING', label: 'The whole building', hints: ['whole building', 'entire building', 'whole block', 'entire block'] },
  { value: 'CAMPUS', label: 'Across campus', hints: ['whole campus', 'across campus', 'entire campus'] },
];

export const DURATION_OPTIONS: SlotOption[] = [
  { value: 'JUST_NOW', label: 'Just started', hints: ['just now', 'just started', 'right now', 'a few minutes'] },
  { value: 'TODAY', label: 'Since today', hints: ['since morning', 'since today', 'all day', 'today'] },
  { value: 'ONE_DAY', label: 'More than a day', hints: ['since yesterday', 'more than a day', 'last night'] },
  { value: 'MULTI_DAY', label: 'Several days', hints: ['for days', 'several days', 'a week', 'past week', 'since monday'] },
];

export const IMPACT_OPTIONS: SlotOption[] = [
  { value: 'EXAM', label: 'An exam or test', hints: ['exam', 'online test', 'viva', 'quiz'] },
  { value: 'CLASS', label: 'A class in progress', hints: ['class', 'lecture', 'lab session'] },
  { value: 'ASSIGNMENT', label: 'An assignment deadline', hints: ['assignment', 'submission', 'deadline', 'project due'] },
  { value: 'NONE', label: 'Nothing urgent', hints: ['nothing urgent', 'not urgent'] },
];

/** Overrides let a category reword the question without restating the options. */
type SlotOverrides = Partial<Slot> & { question?: string };

export function scopeSlot(overrides: SlotOverrides = {}): Slot {
  return {
    key: 'scope',
    question: 'Is this affecting only you, or others as well?',
    type: 'enum',
    importance: 'RECOMMENDED',
    infoGain: 0.9,
    priorityDiscriminating: true,
    signal: 'SCOPE',
    options: SCOPE_OPTIONS,
    ...overrides,
  };
}

export function durationSlot(overrides: SlotOverrides = {}): Slot {
  return {
    key: 'duration',
    question: 'How long has this been going on?',
    type: 'enum',
    importance: 'RECOMMENDED',
    infoGain: 0.7,
    priorityDiscriminating: true,
    signal: 'DURATION',
    options: DURATION_OPTIONS,
    ...overrides,
  };
}

export function impactSlot(overrides: SlotOverrides = {}): Slot {
  return {
    key: 'impact',
    question: 'Is this blocking anything urgent right now?',
    type: 'enum',
    importance: 'RECOMMENDED',
    infoGain: 0.6,
    priorityDiscriminating: true,
    signal: 'IMPACT',
    options: IMPACT_OPTIONS,
    ...overrides,
  };
}

export function recurringSlot(overrides: SlotOverrides = {}): Slot {
  return {
    key: 'recurring',
    question: 'Has this happened before?',
    type: 'boolean',
    importance: 'RECOMMENDED',
    infoGain: 0.5,
    priorityDiscriminating: true,
    signal: 'RECURRING',
    ...overrides,
  };
}

export function locationSlot(overrides: SlotOverrides = {}): Slot {
  return {
    key: 'location',
    question: 'Where is this? (building, floor or room)',
    type: 'location',
    importance: 'REQUIRED',
    infoGain: 1,
    unsureDefault: null,
    ...overrides,
  };
}

export function detailsSlot(overrides: SlotOverrides = {}): Slot {
  return {
    key: 'details',
    question: 'Anything else we should know?',
    type: 'text',
    importance: 'OPTIONAL',
    infoGain: 0.2,
    placeholder: 'Optional',
    ...overrides,
  };
}

/**
 * "Is anyone at risk right now?" — the question that turns a hazard report into
 * a CRITICAL one (§7 example). Only asked once a hazard has been established,
 * so each category supplies its own `askIf`.
 */
export function personAtRiskSlot(overrides: SlotOverrides): Slot {
  return {
    key: 'person_at_risk',
    question: 'Is anyone in immediate danger, or is the area accessible to people right now?',
    type: 'boolean',
    importance: 'REQUIRED',
    infoGain: 1,
    safetyCritical: true,
    allowSkip: false,
    signal: 'PERSON_AT_RISK',
    criticalValues: [true],
    unsureDefault: true,
    ...overrides,
  };
}

/**
 * Health fallout from food (§8 hostel food / canteen). An enum rather than a
 * boolean because the hazard vocabulary attaches to options, and because
 * "several people are unwell" is a different report from "I felt off".
 */
export function healthImpactSlot(overrides: SlotOverrides = {}): Slot {
  return {
    key: 'health_impact',
    question: 'Has anyone fallen ill after eating?',
    type: 'enum',
    importance: 'REQUIRED',
    infoGain: 1,
    safetyCritical: true,
    allowSkip: false,
    criticalValues: ['MULTIPLE_UNWELL', 'HOSPITAL'],
    unsureDefault: 'NOBODY_UNWELL',
    options: [
      { value: 'NOBODY_UNWELL', label: 'Nobody is unwell', hints: ['nobody is unwell', 'no one fell ill'] },
      { value: 'FELT_UNWELL', label: 'I felt unwell', hazard: 'FOOD_ILLNESS', hints: ['i felt sick', 'i felt unwell', 'upset stomach', 'stomach ache'] },
      { value: 'MULTIPLE_UNWELL', label: 'Several people fell ill', hazard: 'FOOD_ILLNESS', hints: ['many fell ill', 'several fell ill', 'everyone fell sick', 'food poisoning'] },
      { value: 'HOSPITAL', label: 'Someone needed medical help', hazard: 'FOOD_ILLNESS', hints: ['hospital', 'infirmary', 'ambulance', 'medical help'] },
    ],
    ...overrides,
  };
}
