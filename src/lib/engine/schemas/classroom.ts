import type { CategorySchema } from '../types';
import { detailsSlot, durationSlot, impactSlot, locationSlot, scopeSlot } from './shared';

/** Spec §8 — which classroom, what is wrong, is the class affected right now. */
export const classroomSchema: CategorySchema = {
  key: 'CLASSROOM',
  label: 'Classroom facilities',
  description: 'Projector, board, AC, mic or seating problems in a classroom',
  keywords: [
    'classroom',
    'class room',
    'lecture hall',
    'projector',
    'screen',
    'whiteboard',
    'blackboard',
    'board',
    'mic',
    'microphone',
    'speaker',
    'podium',
    'smart board',
    'smart panel',
  ],
  subcategorySlot: 'problem_type',
  dedupWindowHours: 24,
  slots: [
    {
      key: 'problem_type',
      question: 'What is wrong in the classroom?',
      type: 'enum',
      importance: 'REQUIRED',
      infoGain: 0.9,
      options: [
        { value: 'PROJECTOR', label: 'Projector not working', hints: ['projector', 'beamer', 'no display', 'no projection'] },
        { value: 'SMART_PANEL', label: 'Smart board / panel not working', hints: ['smart board', 'smart panel', 'interactive board', 'touch panel'] },
        { value: 'AUDIO', label: 'Mic or speakers not working', hints: ['mic', 'microphone', 'speaker', 'audio', 'sound not'] },
        { value: 'AC', label: 'AC not working', hints: ['ac not', 'air conditioner', 'air conditioning', 'no cooling'] },
        { value: 'LIGHTS_FANS', label: 'Lights or fans not working', hints: ['light not', 'lights not', 'fan not', 'tubelight'] },
        { value: 'SEATING', label: 'Broken benches or seating', hints: ['bench', 'benches', 'desk broken', 'chair broken', 'seating'] },
        { value: 'BOARD', label: 'Board damaged or unusable', hints: ['board damaged', 'whiteboard', 'blackboard', 'cannot write'] },
        { value: 'CLEANLINESS', label: 'Room is not cleaned', hints: ['not cleaned', 'dirty', 'dusty', 'garbage'] },
        { value: 'OTHER', label: 'Something else' },
      ],
      extractHints: ['classroom', 'lecture hall'],
      unsureDefault: 'OTHER',
    },
    locationSlot({ question: 'Which room is this? (block and room number)', placeholder: 'e.g. CSE 101' }),
    impactSlot({
      question: 'Is a class or exam affected right now?',
      importance: 'RECOMMENDED',
      infoGain: 0.8,
    }),
    scopeSlot({
      question: 'Is it just this room, or more of the block?',
      infoGain: 0.7,
      options: [
        { value: 'ONLY_ME', label: 'Just this room', hints: ['just this room', 'only this room', 'this classroom only'] },
        { value: 'FEW', label: 'A few rooms', hints: ['few rooms', 'couple of rooms', 'some rooms'] },
        { value: 'MANY', label: 'Most of the floor', hints: ['whole floor', 'entire floor', 'all rooms on'] },
        { value: 'BUILDING', label: 'The whole block', hints: ['whole block', 'entire block', 'whole building'] },
      ],
    }),
    durationSlot({ question: 'How long has it been like this?' }),
    detailsSlot({ question: 'Anything else that would help the technician?' }),
  ],
};
