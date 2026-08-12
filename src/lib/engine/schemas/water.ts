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
 * §14 lists major water leakage as a CRITICAL example, so this category carries
 * a safety slot of its own: a burst pipe near a switchboard is a live danger,
 * a dripping tap is not.
 */
export const waterSchema: CategorySchema = {
  key: 'WATER',
  label: 'Water / Plumbing',
  description: 'No water, leaks, burst pipes, blocked drains, dirty water',
  keywords: [
    'water',
    'tap',
    'pipe',
    'pipeline',
    'leak',
    'leakage',
    'leaking',
    'plumbing',
    'drain',
    'drainage',
    'sewage',
    'flush',
    'geyser',
    'overflow',
    'flooded',
    'flooding',
    'burst',
  ],
  subcategorySlot: 'problem_type',
  dedupWindowHours: 24,
  slots: [
    {
      key: 'water_hazard',
      question: 'Is any of this happening right now?',
      type: 'multi',
      importance: 'REQUIRED',
      infoGain: 1,
      safetyCritical: true,
      allowSkip: false,
      criticalValues: ['FLOODING', 'NEAR_ELECTRICAL', 'CEILING_DAMAGE'],
      options: [
        {
          value: 'FLOODING',
          label: 'Water is flooding the area',
          hazard: 'FLOODING',
          hints: ['flooding', 'flooded', 'ankle deep', 'water everywhere', 'gushing'],
        },
        {
          value: 'NEAR_ELECTRICAL',
          label: 'Water is reaching wiring or a switchboard',
          hazard: 'ELECTRIC_SHOCK',
          hints: ['near switchboard', 'on the switchboard', 'into the socket', 'near wiring', 'onto wires'],
        },
        {
          value: 'CEILING_DAMAGE',
          label: 'Ceiling or wall is sagging / crumbling',
          hazard: 'STRUCTURAL',
          hints: ['ceiling sagging', 'plaster falling', 'ceiling leaking', 'wall crumbling'],
        },
        {
          value: 'CONTAMINATED',
          label: 'Sewage mixing with clean water',
          hazard: 'SEWAGE',
          hints: ['sewage', 'drain water mixing', 'foul water', 'contaminated'],
        },
        { value: 'NONE', label: 'None of these', hints: ['nothing like that', 'no hazard'] },
      ],
      unsureDefault: 'NONE',
    },
    personAtRiskSlot({
      askIf: {
        slot: 'water_hazard',
        op: 'in',
        value: ['FLOODING', 'NEAR_ELECTRICAL', 'CEILING_DAMAGE'],
      },
    }),
    {
      key: 'problem_type',
      question: 'What is the water problem?',
      type: 'enum',
      importance: 'REQUIRED',
      infoGain: 0.9,
      options: [
        { value: 'NO_WATER', label: 'No water supply', hints: ['no water', 'water not coming', 'supply stopped', 'dry tap'] },
        { value: 'LOW_PRESSURE', label: 'Very low pressure', hints: ['low pressure', 'trickle', 'slow water'] },
        { value: 'LEAK', label: 'Leaking tap or pipe', hints: ['leaking', 'leakage', 'dripping', 'leak'] },
        { value: 'PIPE_BURST', label: 'Burst pipe', hazard: 'MAJOR_LEAK', hints: ['pipe burst', 'burst pipe', 'pipe broke', 'main line burst'] },
        { value: 'BLOCKED_DRAIN', label: 'Blocked drain', hints: ['blocked drain', 'clogged', 'not draining', 'choked'] },
        { value: 'SEWAGE_OVERFLOW', label: 'Sewage overflow', hazard: 'SEWAGE', hints: ['sewage overflow', 'drain overflowing', 'manhole'] },
        { value: 'DIRTY_WATER', label: 'Dirty or smelly water', hints: ['dirty water', 'muddy water', 'brown water', 'smelly water'] },
        { value: 'HOT_WATER', label: 'No hot water / geyser', hints: ['no hot water', 'geyser', 'water heater'] },
      ],
      extractHints: ['water', 'plumbing'],
      unsureDefault: 'NO_WATER',
    },
    locationSlot({ placeholder: 'e.g. Boys Hostel A, 2nd floor washroom' }),
    scopeSlot({
      question: 'How much of the area is affected?',
      options: [
        { value: 'ONLY_ME', label: 'Just my room / one fixture', hints: ['only my room', 'just my room', 'one tap'] },
        { value: 'FEW', label: 'A few rooms', hints: ['few rooms', 'some rooms', 'couple of rooms'] },
        { value: 'MANY', label: 'The whole floor', hints: ['whole floor', 'entire floor', 'all rooms on'] },
        { value: 'BUILDING', label: 'The whole building', hints: ['whole building', 'entire building', 'whole hostel', 'entire hostel', 'whole block'] },
        { value: 'CAMPUS', label: 'Across campus', hints: ['whole campus', 'across campus'] },
      ],
    }),
    durationSlot({ question: 'How long has it been like this?' }),
    recurringSlot({ question: 'Does this keep happening here?' }),
    detailsSlot(),
  ],
};
