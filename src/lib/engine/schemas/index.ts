import type { CategorySchema } from '../types';
import { networkSchema } from './network';
import { electricalSchema } from './electrical';
import { classroomSchema } from './classroom';
import { hostelSchema } from './hostel';
import { hostelFoodSchema } from './hostel-food';
import { waterSchema } from './water';
import { transportSchema } from './transport';
import { sanitationSchema } from './sanitation';
import { furnitureSchema } from './furniture';
import { securitySchema } from './security';
import { canteenSchema } from './canteen';
import { librarySchema } from './library';
import { labOtherSchema } from './lab-other';

/**
 * Every spec category, each with a full slot schema. WiFi + Electrical shipped
 * first in Layer 2 (the simple path and the safety-critical short-circuit); the
 * other 11 landed as a breadth pass in the same format.
 *
 * Order matters in one place only: it is the order of the category picker.
 * LAB_OTHER is last because it is also the catch-all.
 */
export const CATEGORY_SCHEMAS: CategorySchema[] = [
  networkSchema,
  electricalSchema,
  classroomSchema,
  hostelSchema,
  hostelFoodSchema,
  waterSchema,
  sanitationSchema,
  furnitureSchema,
  securitySchema,
  transportSchema,
  canteenSchema,
  librarySchema,
  labOtherSchema,
];

export const CATEGORY_BY_KEY: Record<string, CategorySchema> = Object.fromEntries(
  CATEGORY_SCHEMAS.map((c) => [c.key, c]),
);

export function getCategory(key: string | null | undefined): CategorySchema | null {
  if (!key) return null;
  return CATEGORY_BY_KEY[key] ?? null;
}

export function getSlot(categoryKey: string, slotKey: string) {
  return getCategory(categoryKey)?.slots.find((s) => s.key === slotKey) ?? null;
}

/**
 * Every category the spec names. Routing rules, priority bases and analytics are
 * keyed off this list; `CATEGORY_SCHEMAS` now covers all of it.
 */
export const ALL_CATEGORY_KEYS = [
  'NETWORK',
  'ELECTRICAL',
  'CLASSROOM',
  'HOSTEL',
  'HOSTEL_FOOD',
  'WATER',
  'TRANSPORT',
  'SANITATION',
  'FURNITURE',
  'SECURITY',
  'CANTEEN',
  'LIBRARY',
  'LAB_OTHER',
] as const;

export type CategoryKey = (typeof ALL_CATEGORY_KEYS)[number];

export const CATEGORY_LABELS: Record<CategoryKey, string> = {
  NETWORK: 'WiFi / Internet',
  ELECTRICAL: 'Electrical',
  CLASSROOM: 'Classroom facilities',
  HOSTEL: 'Hostel',
  HOSTEL_FOOD: 'Hostel food',
  WATER: 'Water / Plumbing',
  TRANSPORT: 'Transport',
  SANITATION: 'Sanitation / Cleaning',
  FURNITURE: 'Furniture',
  SECURITY: 'Security',
  CANTEEN: 'Canteen',
  LIBRARY: 'Library',
  LAB_OTHER: 'Lab / Other',
};

export {
  networkSchema,
  electricalSchema,
  classroomSchema,
  hostelSchema,
  hostelFoodSchema,
  waterSchema,
  sanitationSchema,
  furnitureSchema,
  securitySchema,
  transportSchema,
  canteenSchema,
  librarySchema,
  labOtherSchema,
};
