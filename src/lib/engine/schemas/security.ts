import type { CategorySchema } from '../types';
import { detailsSlot, durationSlot, locationSlot, scopeSlot } from './shared';

/**
 * §14 lists a security threat as CRITICAL. The deciding question is whether it
 * is happening *now*, so that slot is safetyCritical and short-circuits the
 * conversation rather than collecting six fields during an incident.
 */
export const securitySchema: CategorySchema = {
  key: 'SECURITY',
  label: 'Security',
  description: 'Unsafe situations, theft, harassment, broken locks, dark areas',
  keywords: [
    'security',
    'theft',
    'stolen',
    'robbery',
    'harassment',
    'harassed',
    'stalking',
    'following me',
    'unsafe',
    'threat',
    'fight',
    'trespass',
    'intruder',
    'stranger',
    'cctv',
    'guard',
    'fire extinguisher',
  ],
  subcategorySlot: 'problem_type',
  dedupWindowHours: 12,
  slots: [
    {
      key: 'problem_type',
      question: 'What kind of security issue is this?',
      type: 'enum',
      importance: 'REQUIRED',
      infoGain: 1,
      options: [
        { value: 'INTRUDER', label: 'Unknown person / trespasser', hazard: 'SECURITY_THREAT', hints: ['intruder', 'trespass', 'stranger', 'unknown person', 'outsider'] },
        { value: 'VIOLENCE', label: 'Fight or physical threat', hazard: 'SECURITY_THREAT', hints: ['fight', 'assault', 'beating', 'attacked', 'threatened me'] },
        { value: 'HARASSMENT', label: 'Harassment or stalking', hazard: 'HARASSMENT', hints: ['harassment', 'harassed', 'stalking', 'following me', 'inappropriate'] },
        { value: 'THEFT', label: 'Theft or missing property', hints: ['theft', 'stolen', 'missing', 'robbed', 'took my'] },
        { value: 'FIRE_SAFETY', label: 'Fire hazard / missing fire equipment', hazard: 'FIRE', hints: ['fire', 'fire extinguisher', 'smoke alarm', 'fire exit blocked'] },
        { value: 'ACCESS_CONTROL', label: 'Broken gate, lock or barrier', hints: ['gate broken', 'lock broken', 'barrier', 'anyone can enter'] },
        { value: 'LIGHTING', label: 'Unsafe dark area', hints: ['dark', 'no lighting', 'street light', 'unlit'] },
        { value: 'CCTV', label: 'CCTV not working', hints: ['cctv', 'camera not working', 'surveillance'] },
        { value: 'VEHICLE', label: 'Vehicle or parking safety', hints: ['parking', 'vehicle', 'bike stolen', 'car damaged'] },
      ],
      extractHints: ['security', 'unsafe'],
      unsureDefault: 'ACCESS_CONTROL',
    },
    {
      key: 'happening_now',
      question: 'Is this happening right now?',
      type: 'boolean',
      importance: 'REQUIRED',
      infoGain: 1,
      safetyCritical: true,
      allowSkip: false,
      signal: 'PERSON_AT_RISK',
      criticalValues: [true],
      unsureDefault: true,
      askIf: {
        slot: 'problem_type',
        op: 'in',
        value: ['INTRUDER', 'VIOLENCE', 'HARASSMENT', 'FIRE_SAFETY'],
      },
    },
    locationSlot({ question: 'Where is this? (as precisely as you can)' }),
    scopeSlot({
      question: 'Who is affected?',
      options: [
        { value: 'ONLY_ME', label: 'Just me', hints: ['just me', 'only me'] },
        { value: 'FEW', label: 'A few students', hints: ['few of us', 'some of us'] },
        { value: 'MANY', label: 'Many students in the area', hints: ['everyone', 'many students', 'all of us'] },
        { value: 'BUILDING', label: 'The whole building', hints: ['whole building', 'entire hostel', 'whole block'] },
        { value: 'CAMPUS', label: 'Campus-wide concern', hints: ['whole campus', 'across campus'] },
      ],
    }),
    durationSlot({ question: 'When did this start?' }),
    detailsSlot({ question: 'Anything else security should know before they arrive?' }),
  ],
};
