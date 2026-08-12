import type { CategorySchema } from '../types';
import {
  detailsSlot,
  durationSlot,
  impactSlot,
  locationSlot,
  personAtRiskSlot,
  scopeSlot,
} from './shared';

/**
 * Labs plus the catch-all. A chemical spill or gas leak in a lab is a genuine
 * emergency, so the hazard question comes first here too; everything that does
 * not fit another category also lands here, which is why routing confidence for
 * LAB_OTHER is seeded low enough to send unclear reports to triage (§41).
 */
export const labOtherSchema: CategorySchema = {
  key: 'LAB_OTHER',
  label: 'Lab / Other',
  description: 'Lab equipment, computers, chemicals — or anything not listed',
  keywords: [
    'lab',
    'laboratory',
    'workshop',
    'equipment',
    'apparatus',
    'oscilloscope',
    'microscope',
    'chemical',
    'reagent',
    'fume hood',
    'gas cylinder',
    'lathe',
    'machine',
    'lab computer',
    'lab pc',
  ],
  subcategorySlot: 'problem_type',
  dedupWindowHours: 24,
  slots: [
    {
      key: 'lab_hazard',
      question: 'Is any of this happening right now?',
      type: 'multi',
      importance: 'REQUIRED',
      infoGain: 1,
      safetyCritical: true,
      allowSkip: false,
      criticalValues: ['CHEMICAL_SPILL', 'GAS_LEAK', 'FIRE', 'INJURY'],
      options: [
        { value: 'CHEMICAL_SPILL', label: 'Chemical spill or fumes', hazard: 'CHEMICAL', hints: ['chemical spill', 'spilled', 'fumes', 'acid', 'reagent leaked'] },
        { value: 'GAS_LEAK', label: 'Gas leak or smell of gas', hazard: 'GAS_LEAK', hints: ['gas leak', 'smell of gas', 'lpg', 'cylinder leaking'] },
        { value: 'FIRE', label: 'Fire or smoke', hazard: 'FIRE', hints: ['fire', 'flames', 'smoke', 'burning'] },
        { value: 'INJURY', label: 'Someone has been hurt', hazard: 'INJURY', hints: ['injured', 'hurt', 'bleeding', 'burn'] },
        { value: 'MACHINE_UNSAFE', label: 'Machine running unsafely', hazard: 'INJURY', hints: ['machine not stopping', 'guard missing', 'exposed belt', 'unsafe machine'] },
        { value: 'NONE', label: 'None of these', hints: ['nothing like that', 'no hazard'] },
      ],
      unsureDefault: 'NONE',
    },
    personAtRiskSlot({
      askIf: {
        slot: 'lab_hazard',
        op: 'in',
        value: ['CHEMICAL_SPILL', 'GAS_LEAK', 'FIRE', 'INJURY', 'MACHINE_UNSAFE'],
      },
    }),
    {
      key: 'problem_type',
      question: 'What is the problem?',
      type: 'enum',
      importance: 'REQUIRED',
      infoGain: 0.9,
      options: [
        { value: 'EQUIPMENT_BROKEN', label: 'Lab equipment not working', hints: ['equipment not working', 'apparatus broken', 'instrument not working', 'machine broken'] },
        { value: 'COMPUTER', label: 'Lab computer problem', hints: ['lab computer', 'lab pc', 'desktop not', 'system not booting'] },
        { value: 'SOFTWARE', label: 'Software missing or licence expired', hints: ['software not installed', 'licence expired', 'license expired', 'matlab', 'not installed'] },
        { value: 'NO_POWER_AT_STATION', label: 'No power at the work station', hints: ['no power', 'socket not working', 'no supply at bench'] },
        { value: 'CONSUMABLES', label: 'Consumables or components missing', hints: ['no components', 'out of stock', 'consumables', 'no reagent'] },
        { value: 'SAFETY_EQUIPMENT', label: 'Safety equipment missing', hazard: 'INJURY', hints: ['no gloves', 'no goggles', 'fire extinguisher missing', 'no safety'] },
        { value: 'OTHER', label: 'Something else entirely', hints: ['other', 'not listed'] },
      ],
      extractHints: ['lab', 'equipment'],
      unsureDefault: 'OTHER',
    },
    locationSlot({ question: 'Which lab or place is this?', placeholder: 'e.g. CSE Networks Lab' }),
    impactSlot({ question: 'Is a lab session, exam or submission affected?' }),
    scopeSlot({
      question: 'How much is affected?',
      options: [
        { value: 'ONLY_ME', label: 'Just my station', hints: ['my station', 'one system', 'just mine', 'my pc'] },
        { value: 'FEW', label: 'A few stations', hints: ['few systems', 'some machines', 'couple of'] },
        { value: 'MANY', label: 'Most of the lab', hints: ['whole lab', 'most systems', 'all machines', 'entire lab'] },
        { value: 'BUILDING', label: 'Several labs in the block', hints: ['all labs', 'several labs', 'whole block'] },
      ],
    }),
    durationSlot({ question: 'How long has it been like this?' }),
    detailsSlot({ question: 'Anything else (equipment name, error message)?' }),
  ],
};
