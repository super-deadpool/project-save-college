import type { CategorySchema } from '../types';
import { detailsSlot, durationSlot, locationSlot, scopeSlot } from './shared';

/**
 * §14 puts minor furniture problems at LOW — but a bed frame about to collapse
 * or a bench with exposed nails is an injury risk, so the hazard question is
 * asked before anything else and can lift the band.
 */
export const furnitureSchema: CategorySchema = {
  key: 'FURNITURE',
  label: 'Furniture',
  description: 'Broken chairs, desks, beds, cupboards, doors and fittings',
  keywords: [
    'furniture',
    'chair',
    'bench',
    'desk',
    'table',
    'bed',
    'cot',
    'cupboard',
    'almirah',
    'wardrobe',
    'shelf',
    'drawer',
    'hinge',
    'broken leg',
    'wobbly',
  ],
  subcategorySlot: 'problem_type',
  dedupWindowHours: 72,
  slots: [
    {
      key: 'injury_risk',
      question: 'Could it hurt someone as it is?',
      type: 'enum',
      importance: 'REQUIRED',
      infoGain: 1,
      // safetyCritical to jump the question queue, but deliberately no
      // criticalValues: a broken bench is an injury risk, not live danger, so it
      // scores through the hazard term instead of short-circuiting as CRITICAL.
      safetyCritical: true,
      allowSkip: false,
      options: [
        { value: 'SHARP_EDGE', label: 'Sharp edge, nail or broken glass', hazard: 'INJURY', hints: ['nail sticking', 'sharp edge', 'broken glass', 'splinter', 'cut myself'] },
        { value: 'COLLAPSE_RISK', label: 'It could collapse under someone', hazard: 'STRUCTURAL', hints: ['about to collapse', 'will collapse', 'gave way', 'fell down', 'unstable'] },
        { value: 'NO', label: 'No, it is just unusable', hints: ['just broken', 'not dangerous', 'no risk'] },
      ],
      unsureDefault: 'NO',
    },
    {
      key: 'problem_type',
      question: 'What is broken?',
      type: 'enum',
      importance: 'REQUIRED',
      infoGain: 0.9,
      options: [
        { value: 'CHAIR', label: 'Chair or bench', hints: ['chair', 'bench', 'stool'] },
        { value: 'DESK', label: 'Desk or table', hints: ['desk', 'table', 'writing pad'] },
        { value: 'BED', label: 'Bed or mattress', hints: ['bed', 'cot', 'mattress', 'bunk'] },
        { value: 'CUPBOARD', label: 'Cupboard, shelf or drawer', hints: ['cupboard', 'almirah', 'wardrobe', 'shelf', 'drawer', 'locker'] },
        { value: 'DOOR_WINDOW', label: 'Door, window or fitting', hints: ['door', 'window', 'hinge', 'handle', 'latch'] },
        { value: 'FIXTURE', label: 'Fixed fitting (board, rack, mirror)', hints: ['notice board', 'rack', 'mirror', 'bracket'] },
        { value: 'OTHER', label: 'Something else' },
      ],
      extractHints: ['furniture', 'broken'],
      unsureDefault: 'OTHER',
    },
    locationSlot({ question: 'Where is it? (building, room)' }),
    {
      key: 'item_count',
      question: 'How many items are affected?',
      type: 'number',
      importance: 'OPTIONAL',
      infoGain: 0.3,
      placeholder: 'e.g. 4',
    },
    scopeSlot({
      question: 'Is it one item or more of the room?',
      importance: 'RECOMMENDED',
      options: [
        { value: 'ONLY_ME', label: 'Just one item', hints: ['one chair', 'one desk', 'just one', 'my chair'] },
        { value: 'FEW', label: 'A few items', hints: ['few chairs', 'some benches', 'couple of'] },
        { value: 'MANY', label: 'Most of the room', hints: ['most of the', 'many chairs', 'whole room'] },
        { value: 'BUILDING', label: 'Across the building', hints: ['whole building', 'every classroom', 'across the block'] },
      ],
    }),
    durationSlot({ question: 'How long has it been like this?' }),
    detailsSlot(),
  ],
};
