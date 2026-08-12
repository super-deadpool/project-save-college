import type { CategorySchema } from '../types';
import { detailsSlot, impactSlot, locationSlot, scopeSlot } from './shared';

/** Spec §8 — which route, which bus, what time, what happened, students affected now. */
export const transportSchema: CategorySchema = {
  key: 'TRANSPORT',
  label: 'Transport',
  description: 'Campus bus breakdowns, delays, overcrowding, driver conduct',
  keywords: [
    'bus',
    'transport',
    'shuttle',
    'van',
    'route',
    'driver',
    'conductor',
    'breakdown',
    'stop',
    'bus bay',
    'pickup',
    'drop',
  ],
  subcategorySlot: 'problem_type',
  dedupWindowHours: 12,
  slots: [
    {
      key: 'problem_type',
      question: 'What happened?',
      type: 'enum',
      importance: 'REQUIRED',
      infoGain: 0.9,
      options: [
        { value: 'BREAKDOWN', label: 'Bus broke down', hints: ['broke down', 'breakdown', 'stalled', 'engine failed'] },
        { value: 'ACCIDENT', label: 'Accident or collision', hazard: 'INJURY', hints: ['accident', 'collision', 'hit a', 'crashed'] },
        { value: 'RASH_DRIVING', label: 'Rash or unsafe driving', hazard: 'INJURY', hints: ['rash driving', 'speeding', 'overspeeding', 'reckless', 'unsafe driving'] },
        { value: 'NOT_ARRIVED', label: 'Bus never arrived', hints: ['did not come', 'never arrived', 'no bus', 'bus missing'] },
        { value: 'DELAY', label: 'Bus was late', hints: ['late', 'delayed', 'delay', 'waiting since'] },
        { value: 'OVERCROWDING', label: 'Dangerous overcrowding', hints: ['overcrowded', 'too crowded', 'no space', 'hanging out of'] },
        { value: 'STAFF_CONDUCT', label: 'Driver or conductor behaviour', hints: ['driver behaviour', 'rude', 'misbehaved', 'refused to stop'] },
        { value: 'ROUTE_STOP', label: 'Route or stop problem', hints: ['route changed', 'stop skipped', 'did not stop', 'wrong route'] },
        { value: 'CONDITION', label: 'Bus condition (seats, doors, cleanliness)', hints: ['seat broken', 'door not closing', 'dirty bus', 'no lights in bus'] },
      ],
      extractHints: ['bus', 'transport'],
      unsureDefault: 'DELAY',
    },
    impactSlot({
      question: 'Is this making students miss a class or an exam?',
      infoGain: 0.8,
    }),
    {
      key: 'route',
      question: 'Which route or bus number?',
      type: 'text',
      importance: 'RECOMMENDED',
      infoGain: 0.8,
      placeholder: 'e.g. Route 4, bus KA-01-1234',
    },
    {
      key: 'scheduled_time',
      question: 'What time was it scheduled for?',
      type: 'text',
      importance: 'RECOMMENDED',
      infoGain: 0.6,
      placeholder: 'e.g. 8:15 am',
    },
    locationSlot({
      question: 'Where did this happen? (stop or area)',
      importance: 'RECOMMENDED',
      placeholder: 'e.g. Bus Bay',
    }),
    scopeSlot({
      question: 'How many students were affected?',
      options: [
        { value: 'ONLY_ME', label: 'Just me', hints: ['just me', 'only me'] },
        { value: 'FEW', label: 'A few of us', hints: ['few of us', 'some of us', 'couple of us'] },
        { value: 'MANY', label: 'A busload of students', hints: ['everyone', 'all of us', 'whole bus', 'busload', 'many students'] },
        { value: 'CAMPUS', label: 'Several routes across campus', hints: ['all routes', 'several routes', 'every bus'] },
      ],
    }),
    detailsSlot({ question: 'Anything else about what happened?' }),
  ],
};
