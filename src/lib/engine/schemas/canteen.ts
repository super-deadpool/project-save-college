import type { CategorySchema } from '../types';
import { detailsSlot, healthImpactSlot, locationSlot, recurringSlot, scopeSlot } from './shared';

/** Distinct from HOSTEL_FOOD: paid outlets, so billing and staff conduct matter. */
export const canteenSchema: CategorySchema = {
  key: 'CANTEEN',
  label: 'Canteen',
  description: 'Canteen hygiene, food quality, overcharging, long waits',
  keywords: [
    'canteen',
    'cafeteria',
    'cafe',
    'juice shop',
    'snack bar',
    'overcharging',
    'overcharged',
    'bill',
    'mrp',
    'counter',
    'stall',
  ],
  subcategorySlot: 'problem_type',
  dedupWindowHours: 24,
  slots: [
    {
      key: 'problem_type',
      question: 'What is the problem at the canteen?',
      type: 'enum',
      importance: 'REQUIRED',
      infoGain: 0.9,
      options: [
        { value: 'HYGIENE', label: 'Unhygienic counter or utensils', hints: ['unhygienic', 'dirty plates', 'flies', 'dirty counter', 'not clean'] },
        { value: 'STALE_FOOD', label: 'Stale or spoiled food', hazard: 'FOOD_ILLNESS', hints: ['stale', 'spoiled', 'expired', 'rotten', 'smelled bad'] },
        { value: 'FOOD_QUALITY', label: 'Poor food quality', hints: ['bad quality', 'tasteless', 'badly cooked', 'oily'] },
        { value: 'OVERCHARGING', label: 'Overcharging / no bill', hints: ['overcharging', 'overcharged', 'more than mrp', 'no bill', 'extra money'] },
        { value: 'STAFF_CONDUCT', label: 'Staff behaviour', hints: ['rude', 'misbehaved', 'staff behaviour', 'refused to serve'] },
        { value: 'LONG_WAIT', label: 'Very long wait / no service', hints: ['long queue', 'long wait', 'waiting for', 'no service'] },
        { value: 'PAYMENT', label: 'Payment or UPI problem', hints: ['upi', 'payment failed', 'card not working', 'no change'] },
        { value: 'PRICE_LIST', label: 'No price list displayed', hints: ['no price list', 'rates not displayed', 'no menu board'] },
      ],
      extractHints: ['canteen', 'cafeteria'],
      unsureDefault: 'FOOD_QUALITY',
    },
    locationSlot({ question: 'Which canteen or outlet?', placeholder: 'e.g. Main Canteen' }),
    healthImpactSlot({
      askIf: { slot: 'problem_type', op: 'in', value: ['HYGIENE', 'STALE_FOOD', 'FOOD_QUALITY'] },
    }),
    scopeSlot({
      question: 'Did this affect others too?',
      options: [
        { value: 'ONLY_ME', label: 'Only me', hints: ['only me', 'just me'] },
        { value: 'FEW', label: 'A few of us', hints: ['few of us', 'some of us'] },
        { value: 'MANY', label: 'Most customers', hints: ['everyone', 'all of us', 'most people', 'many students'] },
      ],
    }),
    recurringSlot({ question: 'Does this happen regularly here?' }),
    detailsSlot({ question: 'Anything else (item name, amount, time)?' }),
  ],
};
