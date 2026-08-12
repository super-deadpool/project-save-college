import type { CategorySchema, Slot, SlotValues } from './types';

/**
 * Deterministic rendering of a filled slot set: title, description and the
 * "here's what I understood" list (§12). The LLM may later rewrite the prose,
 * but this always works and is what the no-key path uses.
 */

export function labelForValue(slot: Slot, value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((v) => labelForValue(slot, v)).join(', ');
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (value === null || value === undefined || value === '') return '—';
  const option = slot.options?.find((o) => o.value === value);
  return option?.label ?? String(value);
}

export interface SummaryLine {
  slotKey: string;
  label: string;
  display: string;
  state: 'FILLED' | 'UNKNOWN' | 'SKIPPED';
}

export function summaryLines(
  schema: CategorySchema,
  slots: SlotValues,
  locationName?: string | null,
): SummaryLine[] {
  const lines: SummaryLine[] = [];
  for (const slot of schema.slots) {
    const entry = slots[slot.key];
    if (!entry) continue;
    if (entry.state === 'SKIPPED') continue;
    const display =
      entry.state === 'UNKNOWN'
        ? 'Not sure'
        : slot.type === 'location' && locationName
          ? locationName
          : labelForValue(slot, entry.value);
    lines.push({ slotKey: slot.key, label: shortLabel(slot), display, state: entry.state });
  }
  return lines;
}

/** The question text reads oddly as a summary label, so shorten it. */
function shortLabel(slot: Slot): string {
  const overrides: Record<string, string> = {
    problem_type: 'Problem',
    location: 'Location',
    scope: 'Affected',
    duration: 'Since',
    impact: 'Urgency',
    safety_hazard: 'Safety',
    water_hazard: 'Safety',
    lab_hazard: 'Safety',
    injury_risk: 'Injury risk',
    person_at_risk: 'Someone at risk',
    happening_now: 'Happening now',
    health_impact: 'Anyone unwell',
    recurring: 'Happened before',
    device_type: 'Device',
    other_networks_work: 'Other networks work',
    meal: 'Meal',
    meal_date: 'Day',
    route: 'Route / bus',
    scheduled_time: 'Scheduled time',
    item_count: 'Items affected',
    details: 'Extra details',
  };
  return overrides[slot.key] ?? slot.key.replace(/_/g, ' ');
}

export function buildTitle(
  schema: CategorySchema,
  slots: SlotValues,
  locationName?: string | null,
): string {
  const problemSlot = schema.slots.find((s) => s.key === schema.subcategorySlot);
  const problem =
    problemSlot && slots[problemSlot.key]?.state === 'FILLED'
      ? labelForValue(problemSlot, slots[problemSlot.key].value)
      : schema.label;
  return locationName ? `${problem} — ${locationName}` : problem;
}

export function buildDescription(
  schema: CategorySchema,
  slots: SlotValues,
  rawText: string,
  locationName?: string | null,
): string {
  const lines = summaryLines(schema, slots, locationName)
    .filter((l) => l.slotKey !== 'details')
    .map((l) => `${l.label}: ${l.display}`);

  const details = slots['details'];
  const extra =
    details?.state === 'FILLED' && typeof details.value === 'string' ? details.value.trim() : '';

  const blocks = [lines.join('\n')];
  if (extra) blocks.push(`Extra details: ${extra}`);
  if (rawText.trim()) blocks.push(`Reported as: "${rawText.trim()}"`);
  return blocks.join('\n\n');
}
