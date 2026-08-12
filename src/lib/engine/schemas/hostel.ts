import type { CategorySchema } from '../types';
import {
  detailsSlot,
  durationSlot,
  locationSlot,
  personAtRiskSlot,
  recurringSlot,
  scopeSlot,
} from './shared';

/**
 * Spec §8 — which hostel, which room, what type of issue, how many residents,
 * recurring.
 *
 * Scope boundary: this category owns the room and its fittings. Cleaning belongs
 * to SANITATION, taps and drains to WATER, power to ELECTRICAL — overlapping
 * option sets would only make the keyword classifier flip a coin between them.
 */
export const hostelSchema: CategorySchema = {
  key: 'HOSTEL',
  label: 'Hostel',
  description: 'Room, door, window, pests, laundry or hostel facility problems',
  keywords: [
    'hostel',
    'room',
    'warden',
    'roommate',
    'dorm',
    'laundry',
    'cupboard',
    'wardrobe',
    'mattress',
    'bed',
    'pest',
    'cockroach',
    'rats',
    'bedbug',
  ],
  subcategorySlot: 'problem_type',
  dedupWindowHours: 48,
  slots: [
    {
      key: 'problem_type',
      question: 'What kind of hostel issue is this?',
      type: 'enum',
      importance: 'REQUIRED',
      infoGain: 0.9,
      options: [
        { value: 'DOOR_LOCK', label: 'Door or lock broken', hints: ['door broken', 'lock broken', 'latch', 'door not closing', 'cannot lock'] },
        { value: 'WINDOW', label: 'Window broken', hints: ['window broken', 'glass broken', 'window not closing', 'mosquito mesh'] },
        { value: 'PEST', label: 'Pests or insects', hints: ['cockroach', 'rats', 'bedbug', 'bed bug', 'insects', 'pest', 'mosquito'] },
        { value: 'FURNITURE', label: 'Bed, cupboard or table damaged', hints: ['bed broken', 'cupboard', 'wardrobe', 'mattress', 'table broken', 'chair broken'] },
        { value: 'LAUNDRY', label: 'Laundry service problem', hints: ['laundry', 'washing machine', 'clothes'] },
        {
          value: 'STRUCTURAL',
          label: 'Ceiling, wall or floor damage',
          hazard: 'STRUCTURAL',
          hints: ['ceiling', 'plaster', 'wall crack', 'crack in', 'falling', 'collapse'],
        },
        { value: 'NOISE', label: 'Noise or disturbance', hints: ['noise', 'loud music', 'disturbance'] },
        { value: 'ROOM_ALLOCATION', label: 'Room allocation / administrative', hints: ['allocation', 'room change', 'transfer'] },
        { value: 'OTHER', label: 'Something else' },
      ],
      extractHints: ['hostel'],
      unsureDefault: 'OTHER',
    },
    locationSlot({
      question: 'Which hostel and room is this?',
      placeholder: 'e.g. Boys Hostel A, room 214',
    }),
    personAtRiskSlot({
      question: 'Does this look like it could hurt someone — is anyone near it right now?',
      askIf: { slot: 'problem_type', op: 'eq', value: 'STRUCTURAL' },
    }),
    scopeSlot({
      question: 'Is it just your room, or more of the hostel?',
      options: [
        { value: 'ONLY_ME', label: 'Just my room', hints: ['only my room', 'just my room', 'my room only'] },
        { value: 'FEW', label: 'A few rooms', hints: ['few rooms', 'couple of rooms', 'some rooms'] },
        { value: 'MANY', label: 'The whole wing or floor', hints: ['whole floor', 'entire floor', 'whole wing', 'my wing', 'all rooms on'] },
        { value: 'BUILDING', label: 'The whole hostel', hints: ['whole hostel', 'entire hostel', 'whole building', 'entire building'] },
      ],
    }),
    durationSlot({ question: 'How long has it been like this?' }),
    recurringSlot({ question: 'Has this been reported before and come back?' }),
    detailsSlot(),
  ],
};
