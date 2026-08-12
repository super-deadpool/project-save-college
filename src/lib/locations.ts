import { prisma } from '@/lib/db';
import type { LocationType } from '@/generated/prisma/enums';

export interface LocationAncestry {
  id: string;
  name: string;
  type: LocationType;
  criticality: number;
  /** The location itself, then each ancestor up to campus. */
  ancestorIds: string[];
}

/** The tree is at most 4 deep, so walking parents is cheaper than a CTE. */
export async function getLocationAncestry(
  locationId: string | null | undefined,
): Promise<LocationAncestry | null> {
  if (!locationId) return null;

  const ancestorIds: string[] = [];
  let cursor = await prisma.location.findUnique({ where: { id: locationId } });
  if (!cursor) return null;
  const self = cursor;

  while (cursor) {
    ancestorIds.push(cursor.id);
    if (!cursor.parentId) break;
    cursor = await prisma.location.findUnique({ where: { id: cursor.parentId } });
  }

  return {
    id: self.id,
    name: self.name,
    type: self.type,
    criticality: self.criticality,
    ancestorIds,
  };
}

/**
 * Ancestor chains for every location in one query. Dedup scores proximity for a
 * whole candidate set at once, and walking parents per candidate would be a
 * query per level per candidate; the tree is a few dozen rows, so loading it
 * whole is cheaper than being clever.
 */
export async function ancestryIndex(): Promise<Map<string, string[]>> {
  const rows = await prisma.location.findMany({ select: { id: true, parentId: true } });
  const parentOf = new Map(rows.map((r) => [r.id, r.parentId]));
  const index = new Map<string, string[]>();

  for (const row of rows) {
    const chain: string[] = [];
    let cursor: string | null = row.id;
    // Guard against a cycle in seeded data rather than hanging the request.
    while (cursor && chain.length < 16 && !chain.includes(cursor)) {
      chain.push(cursor);
      cursor = parentOf.get(cursor) ?? null;
    }
    index.set(row.id, chain);
  }

  return index;
}

/** Flat list for pickers, ordered so children follow their parent. */
export async function listLocations() {
  const rows = await prisma.location.findMany({
    select: { id: true, code: true, name: true, type: true, parentId: true },
    orderBy: { code: 'asc' },
  });

  const byParent = new Map<string | null, typeof rows>();
  for (const row of rows) {
    const list = byParent.get(row.parentId) ?? [];
    list.push(row);
    byParent.set(row.parentId, list);
  }

  const out: (typeof rows[number] & { depth: number })[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const row of byParent.get(parentId) ?? []) {
      out.push({ ...row, depth });
      walk(row.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}
