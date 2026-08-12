/**
 * §28 — the campus heatmap.
 *
 *     CSE Block  🔴 High · Hostel A 🔴 High · ECE 🟡 Medium · Library 🟢 Low
 *
 * Pure (CLAUDE.md §5): counts per location in, a band and an intensity out.
 *
 * The bands are *relative to the busiest place on campus*, not absolute. An
 * absolute threshold is wrong twice over — it paints everything green in a quiet
 * month and everything red in a bad one — and the question an administrator is
 * asking here is comparative: which building is the problem right now.
 */

export interface LocationDensity {
  locationId: string;
  locationName: string;
  /** The building/area this belongs to, when the row is a room inside one. */
  parentName?: string | null;
  total: number;
  open: number;
  critical: number;
}

export type HeatLevel = 'HIGH' | 'MEDIUM' | 'LOW';

export interface HeatCell extends LocationDensity {
  level: HeatLevel;
  /** 0..1 against the busiest location — what the colour ramp reads. */
  intensity: number;
}

/** Share of the busiest location's volume at which a place turns amber, then red. */
export const HEAT_HIGH = 0.6;
export const HEAT_MEDIUM = 0.3;

/**
 * Below this many complaints a location is never "high", however it compares.
 * On a quiet week the busiest building might have three complaints, and painting
 * it red would make the map say "crisis" about an ordinary Tuesday.
 */
export const HEAT_FLOOR = 3;

export function heatmap(rows: LocationDensity[]): HeatCell[] {
  const busiest = rows.reduce((max, row) => Math.max(max, row.total), 0);

  return rows
    .map((row) => {
      const intensity = busiest === 0 ? 0 : row.total / busiest;
      const level: HeatLevel =
        row.total >= HEAT_FLOOR && intensity >= HEAT_HIGH
          ? 'HIGH'
          : row.total >= HEAT_FLOOR && intensity >= HEAT_MEDIUM
            ? 'MEDIUM'
            : 'LOW';
      return { ...row, intensity, level };
    })
    .sort((a, b) => b.total - a.total || a.locationName.localeCompare(b.locationName));
}

export const HEAT_LABEL: Record<HeatLevel, string> = {
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
};

/**
 * One sentence about the worst place on the map, for the panel heading. Null when
 * there is nothing to say — an empty map should say "no complaints" rather than
 * name a winner out of a field of zeroes.
 */
export function heatmapHeadline(cells: HeatCell[]): string | null {
  const worst = cells.find((c) => c.level === 'HIGH') ?? cells[0];
  if (!worst || worst.total === 0) return null;

  const share = cells.reduce((sum, c) => sum + c.total, 0);
  const percent = share === 0 ? 0 : Math.round((worst.total / share) * 100);
  return `${worst.locationName} accounts for ${percent}% of located complaints — ${worst.total} in total, ${worst.open} still open.`;
}
