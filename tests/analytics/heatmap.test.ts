import { describe, expect, it } from 'vitest';
import { HEAT_FLOOR, heatmap, heatmapHeadline, type LocationDensity } from '@/lib/analytics/heatmap';

function place(name: string, total: number, open = 0, critical = 0): LocationDensity {
  return { locationId: name.toLowerCase().replace(/\s+/g, '-'), locationName: name, total, open, critical };
}

describe('heatmap', () => {
  // §28's own example shape: two red, one amber, two green.
  it('bands locations against the busiest one', () => {
    const cells = heatmap([
      place('CSE Block', 40, 12),
      place('Hostel A', 32, 9),
      place('ECE Block', 15),
      place('Central Library', 6),
      place('Sports Complex', 2),
    ]);

    expect(cells.map((c) => [c.locationName, c.level])).toEqual([
      ['CSE Block', 'HIGH'],
      ['Hostel A', 'HIGH'],
      ['ECE Block', 'MEDIUM'],
      ['Central Library', 'LOW'],
      ['Sports Complex', 'LOW'],
    ]);
    expect(cells[0].intensity).toBe(1);
    expect(cells[1].intensity).toBeCloseTo(0.8, 5);
  });

  it('sorts busiest first, then by name so the order is stable', () => {
    const cells = heatmap([place('Zebra Hall', 5), place('Alpha Hall', 5), place('Busy Block', 9)]);
    expect(cells.map((c) => c.locationName)).toEqual(['Busy Block', 'Alpha Hall', 'Zebra Hall']);
  });

  // On a quiet week the busiest building might have two complaints, and painting
  // it red would make the map say "crisis" about an ordinary Tuesday.
  it('will not call a place high on a handful of complaints', () => {
    const cells = heatmap([place('CSE Block', HEAT_FLOOR - 1), place('Hostel A', 1)]);
    expect(cells.every((c) => c.level === 'LOW')).toBe(true);
  });

  it('survives an empty campus without dividing by zero', () => {
    expect(heatmap([])).toEqual([]);
    const cells = heatmap([place('CSE Block', 0)]);
    expect(cells[0]).toMatchObject({ intensity: 0, level: 'LOW' });
  });
});

describe('heatmapHeadline', () => {
  it('names the worst place and its share', () => {
    const cells = heatmap([place('CSE Block', 40, 12), place('Hostel A', 10, 2)]);
    const headline = heatmapHeadline(cells)!;
    expect(headline).toContain('CSE Block');
    expect(headline).toContain('80%');
    expect(headline).toContain('12 still open');
  });

  it('says nothing rather than crowning a winner out of zeroes', () => {
    expect(heatmapHeadline([])).toBeNull();
    expect(heatmapHeadline(heatmap([place('CSE Block', 0)]))).toBeNull();
  });
});
