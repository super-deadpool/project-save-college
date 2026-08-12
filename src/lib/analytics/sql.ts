import { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/db';
import { SETTLED_STATUSES } from '@/lib/lifecycle/machine';
import { getCategory } from '@/lib/engine/schemas';
import type { MonthlyCount, TrendSeries } from './recurring';
import type { LocationDensity } from './heatmap';
import type { Priority } from '@/generated/prisma/enums';

/**
 * Every aggregation the dashboards read (plan.MD §7 Layer 10). The one module in
 * `analytics/` allowed to touch the database — `recurring.ts`, `heatmap.ts` and
 * `health.ts` are pure and take these rows as input.
 *
 * Raw SQL rather than Prisma's aggregate helpers because each panel wants a dozen
 * numbers over the same scan: §31's overview is nine `FILTER` clauses on one pass
 * of the table, not nine round trips. The counts come back as `bigint` and the
 * averages as `numeric`, so every projection is cast explicitly (`::int`,
 * `::float8`) and nothing downstream has to know that.
 */

export interface AnalyticsWindow {
  from: Date;
  to: Date;
}

/** The last `months` whole months, up to now. The default frame for every panel. */
export function lastMonths(months: number, now: Date = new Date()): AnalyticsWindow {
  const to = new Date(now.getTime());
  const from = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() - (months - 1), 1));
  return { from, to };
}

/** A rolling window of days — what a "last 30 days" sparkline actually means. */
export function lastDays(days: number, now: Date = new Date()): AnalyticsWindow {
  return { from: new Date(now.getTime() - days * 24 * 60 * 60 * 1000), to: new Date(now.getTime()) };
}

/**
 * "Broke its promise", in SQL — the aggregate twin of `sla/breach.ts`.
 *
 * A complaint is counted late if a stamp came in after its deadline, or if the
 * deadline has passed and the stamp still has not come. Both halves are needed:
 * the first is how a finished complaint failed, the second is how a live one is
 * failing right now, and a compliance figure that ignored the second would
 * improve every time a department stopped working on something.
 */
const BREACHED = Prisma.sql`(
  (c."responseDueAt" IS NOT NULL AND (
    (c."respondedAt" IS NOT NULL AND c."respondedAt" > c."responseDueAt") OR
    (c."respondedAt" IS NULL AND NOW() > c."responseDueAt")
  )) OR
  (c."resolutionDueAt" IS NOT NULL AND (
    (c."resolvedAt" IS NOT NULL AND c."resolvedAt" > c."resolutionDueAt") OR
    (c."resolvedAt" IS NULL AND NOW() > c."resolutionDueAt")
  ))
)`;

const HAS_DEADLINE = Prisma.sql`(c."responseDueAt" IS NOT NULL OR c."resolutionDueAt" IS NOT NULL)`;

/** Settled comes from the state machine, so SQL cannot drift from the ladder. */
const SETTLED = Prisma.sql`c."status"::text = ANY(${SETTLED_STATUSES})`;

function windowFilter(window: AnalyticsWindow, departmentId?: string | null) {
  return Prisma.sql`
    c."createdAt" >= ${window.from} AND c."createdAt" <= ${window.to}
    ${departmentId ? Prisma.sql`AND c."departmentId" = ${departmentId}` : Prisma.empty}
  `;
}

/**
 * Each location's building — the depth-one ancestor under the campus root.
 *
 * §28's heatmap is about buildings ("CSE Block 🔴 High"), but complaints attach to
 * whatever the student could name, which is often a room. Walking up to the
 * building is what makes eleven scattered room-level complaints legible as one
 * problem block.
 */
const BUILDING_CTE = Prisma.sql`
  WITH RECURSIVE up AS (
    SELECT l."id" AS leaf, l."id" AS node, l."parentId"
    FROM "Location" l
    UNION ALL
    SELECT u.leaf, p."id", p."parentId"
    FROM up u
    JOIN "Location" p ON p."id" = u."parentId"
  ),
  building AS (
    SELECT u.leaf, u.node AS building_id, b."name" AS building_name
    FROM up u
    JOIN "Location" b ON b."id" = u.node
    JOIN "Location" parent ON parent."id" = u."parentId"
    -- The campus root is the only location with no parent, so its children are
    -- the buildings.
    WHERE parent."parentId" IS NULL
  )
`;

// ---------------------------------------------------------------- §31 overview

export interface OverviewTotals {
  total: number;
  open: number;
  openCritical: number;
  resolved: number;
  closed: number;
  reopened: number;
  withDeadline: number;
  breached: number;
  /** 0..1, or null when nothing carried a deadline. */
  slaCompliance: number | null;
  /** 0..1 of the complaints that reached an end and had to be reopened. */
  reopenRate: number;
  avgResolutionHours: number | null;
  avgResponseMinutes: number | null;
}

interface OverviewRow {
  total: number;
  open: number;
  open_critical: number;
  resolved: number;
  closed: number;
  reopened: number;
  finished: number;
  with_deadline: number;
  breached: number;
  avg_resolution_hours: number | null;
  avg_response_minutes: number | null;
}

export async function overviewTotals(
  window: AnalyticsWindow,
  departmentId?: string | null,
): Promise<OverviewTotals> {
  const [row] = await prisma.$queryRaw<OverviewRow[]>`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE NOT ${SETTLED})::int AS open,
      COUNT(*) FILTER (WHERE NOT ${SETTLED} AND c."priority" = 'CRITICAL')::int AS open_critical,
      COUNT(*) FILTER (WHERE c."status" IN ('RESOLVED', 'CLOSED'))::int AS resolved,
      COUNT(*) FILTER (WHERE c."status" = 'CLOSED')::int AS closed,
      COUNT(*) FILTER (WHERE c."reopenCount" > 0)::int AS reopened,
      COUNT(*) FILTER (WHERE ${SETTLED} OR c."reopenCount" > 0)::int AS finished,
      COUNT(*) FILTER (WHERE ${HAS_DEADLINE})::int AS with_deadline,
      COUNT(*) FILTER (WHERE ${HAS_DEADLINE} AND ${BREACHED})::int AS breached,
      (AVG(EXTRACT(EPOCH FROM (c."resolvedAt" - c."createdAt")) / 3600.0)
        FILTER (WHERE c."resolvedAt" IS NOT NULL))::float8 AS avg_resolution_hours,
      (AVG(EXTRACT(EPOCH FROM (c."respondedAt" - c."createdAt")) / 60.0)
        FILTER (WHERE c."respondedAt" IS NOT NULL))::float8 AS avg_response_minutes
    FROM "Complaint" c
    WHERE ${windowFilter(window, departmentId)}
  `;

  return shapeTotals(row);
}

/** One row of `FILTER` counts becomes the totals every panel reads. */
function shapeTotals(row: OverviewRow): OverviewTotals {
  return {
    total: row.total,
    open: row.open,
    openCritical: row.open_critical,
    resolved: row.resolved,
    closed: row.closed,
    reopened: row.reopened,
    withDeadline: row.with_deadline,
    breached: row.breached,
    slaCompliance: row.with_deadline === 0 ? null : 1 - row.breached / row.with_deadline,
    // The reopen rate is measured against work that reached an end, not against
    // everything: a complaint filed this morning cannot have been reopened yet,
    // and counting it would make the rate improve simply because campus is busy.
    reopenRate: row.finished === 0 ? 0 : row.reopened / row.finished,
    avgResolutionHours: row.avg_resolution_hours,
    avgResponseMinutes: row.avg_response_minutes,
  };
}

export const EMPTY_TOTALS: OverviewTotals = {
  total: 0,
  open: 0,
  openCritical: 0,
  resolved: 0,
  closed: 0,
  reopened: 0,
  withDeadline: 0,
  breached: 0,
  slaCompliance: null,
  reopenRate: 0,
  avgResolutionHours: null,
  avgResponseMinutes: null,
};

/**
 * The same totals, cut by category, in one pass — §34's per-category scores.
 *
 * One query rather than thirteen: every category asking for its own aggregate
 * would be thirteen scans for numbers a single `GROUP BY` already has. Averages
 * are left null here because the category panel does not show them and computing
 * them would make this scan pay for figures nobody reads.
 */
export async function overviewTotalsByCategory(
  window: AnalyticsWindow,
): Promise<Map<string, OverviewTotals>> {
  const rows = await prisma.$queryRaw<(OverviewRow & { category_key: string })[]>`
    SELECT
      c."categoryKey" AS category_key,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE NOT ${SETTLED})::int AS open,
      COUNT(*) FILTER (WHERE NOT ${SETTLED} AND c."priority" = 'CRITICAL')::int AS open_critical,
      COUNT(*) FILTER (WHERE c."status" IN ('RESOLVED', 'CLOSED'))::int AS resolved,
      COUNT(*) FILTER (WHERE c."status" = 'CLOSED')::int AS closed,
      COUNT(*) FILTER (WHERE c."reopenCount" > 0)::int AS reopened,
      COUNT(*) FILTER (WHERE ${SETTLED} OR c."reopenCount" > 0)::int AS finished,
      COUNT(*) FILTER (WHERE ${HAS_DEADLINE})::int AS with_deadline,
      COUNT(*) FILTER (WHERE ${HAS_DEADLINE} AND ${BREACHED})::int AS breached,
      NULL::float8 AS avg_resolution_hours,
      NULL::float8 AS avg_response_minutes
    FROM "Complaint" c
    WHERE ${windowFilter(window)}
    GROUP BY c."categoryKey"
  `;

  return new Map(rows.map((row) => [row.category_key, shapeTotals(row)]));
}

/** §24's ratings for a window — handed to `satisfactionOf()` to aggregate. */
export async function ratingsIn(
  window: AnalyticsWindow,
  departmentId?: string | null,
): Promise<number[]> {
  const rows = await prisma.$queryRaw<{ rating: number }[]>`
    SELECT f."rating"::int AS rating
    FROM "Feedback" f
    JOIN "Complaint" c ON c."id" = f."complaintId"
    WHERE ${windowFilter(window, departmentId)}
  `;
  return rows.map((r) => r.rating);
}

// ---------------------------------------------------------------- §31 distribution

export interface CategoryShare {
  categoryKey: string;
  label: string;
  count: number;
  /** 0..1 of the window's complaints. §31 prints these as percentages. */
  share: number;
  open: number;
  avgResolutionHours: number | null;
}

export async function categoryDistribution(
  window: AnalyticsWindow,
  departmentId?: string | null,
): Promise<CategoryShare[]> {
  const rows = await prisma.$queryRaw<
    { category_key: string; count: number; open: number; avg_resolution_hours: number | null }[]
  >`
    SELECT
      c."categoryKey" AS category_key,
      COUNT(*)::int AS count,
      COUNT(*) FILTER (WHERE NOT ${SETTLED})::int AS open,
      (AVG(EXTRACT(EPOCH FROM (c."resolvedAt" - c."createdAt")) / 3600.0)
        FILTER (WHERE c."resolvedAt" IS NOT NULL))::float8 AS avg_resolution_hours
    FROM "Complaint" c
    WHERE ${windowFilter(window, departmentId)}
    GROUP BY c."categoryKey"
    ORDER BY count DESC
  `;

  const total = rows.reduce((sum, r) => sum + r.count, 0);
  return rows.map((r) => ({
    categoryKey: r.category_key,
    label: getCategory(r.category_key)?.label ?? r.category_key,
    count: r.count,
    share: total === 0 ? 0 : r.count / total,
    open: r.open,
    avgResolutionHours: r.avg_resolution_hours,
  }));
}

// ---------------------------------------------------------------- §31 departments

export interface DepartmentPerformance {
  departmentId: string;
  code: string;
  name: string;
  total: number;
  open: number;
  openCritical: number;
  resolved: number;
  breached: number;
  withDeadline: number;
  slaCompliance: number | null;
  avgResolutionHours: number | null;
  reopened: number;
  satisfaction: number | null;
  ratings: number;
}

export async function departmentPerformance(window: AnalyticsWindow): Promise<DepartmentPerformance[]> {
  const rows = await prisma.$queryRaw<
    {
      department_id: string;
      code: string;
      name: string;
      total: number;
      open: number;
      open_critical: number;
      resolved: number;
      breached: number;
      with_deadline: number;
      reopened: number;
      avg_resolution_hours: number | null;
      satisfaction: number | null;
      ratings: number;
    }[]
  >`
    SELECT
      d."id" AS department_id,
      d."code" AS code,
      d."name" AS name,
      COUNT(c."id")::int AS total,
      COUNT(c."id") FILTER (WHERE NOT ${SETTLED})::int AS open,
      COUNT(c."id") FILTER (WHERE NOT ${SETTLED} AND c."priority" = 'CRITICAL')::int AS open_critical,
      COUNT(c."id") FILTER (WHERE c."status" IN ('RESOLVED', 'CLOSED'))::int AS resolved,
      COUNT(c."id") FILTER (WHERE ${HAS_DEADLINE} AND ${BREACHED})::int AS breached,
      COUNT(c."id") FILTER (WHERE ${HAS_DEADLINE})::int AS with_deadline,
      COUNT(c."id") FILTER (WHERE c."reopenCount" > 0)::int AS reopened,
      (AVG(EXTRACT(EPOCH FROM (c."resolvedAt" - c."createdAt")) / 3600.0)
        FILTER (WHERE c."resolvedAt" IS NOT NULL))::float8 AS avg_resolution_hours,
      AVG(f."rating")::float8 AS satisfaction,
      COUNT(f."id")::int AS ratings
    FROM "Department" d
    LEFT JOIN "Complaint" c
      ON c."departmentId" = d."id"
     AND c."createdAt" >= ${window.from}
     AND c."createdAt" <= ${window.to}
    -- Feedback is unique per complaint, so this join cannot multiply the counts.
    LEFT JOIN "Feedback" f ON f."complaintId" = c."id"
    GROUP BY d."id", d."code", d."name"
    ORDER BY total DESC, d."name" ASC
  `;

  return rows.map((r) => ({
    departmentId: r.department_id,
    code: r.code,
    name: r.name,
    total: r.total,
    open: r.open,
    openCritical: r.open_critical,
    resolved: r.resolved,
    breached: r.breached,
    withDeadline: r.with_deadline,
    slaCompliance: r.with_deadline === 0 ? null : 1 - r.breached / r.with_deadline,
    avgResolutionHours: r.avg_resolution_hours,
    reopened: r.reopened,
    satisfaction: r.satisfaction,
    ratings: r.ratings,
  }));
}

// ---------------------------------------------------------------- §28 heatmap

export async function locationDensity(window: AnalyticsWindow): Promise<LocationDensity[]> {
  const rows = await prisma.$queryRaw<
    { building_id: string; building_name: string; total: number; open: number; critical: number }[]
  >`
    ${BUILDING_CTE}
    SELECT
      b.building_id,
      b.building_name,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE NOT ${SETTLED})::int AS open,
      COUNT(*) FILTER (WHERE c."priority" = 'CRITICAL')::int AS critical
    FROM "Complaint" c
    JOIN building b ON b.leaf = c."locationId"
    WHERE ${windowFilter(window)}
    GROUP BY b.building_id, b.building_name
    ORDER BY total DESC
  `;

  return rows.map((r) => ({
    locationId: r.building_id,
    locationName: r.building_name,
    total: r.total,
    open: r.open,
    critical: r.critical,
  }));
}

// ---------------------------------------------------------------- §27 trend

interface TrendRow {
  month: Date;
  category_key: string;
  building_id: string | null;
  building_name: string | null;
  count: number;
}

/**
 * Monthly counts per (building, category), zero-filled across the window.
 *
 * The zero-filling matters: a series that skips its quiet months looks like
 * `12, 18, 27, 43` whether or not there were three silent months in between, and
 * §27's whole claim is about a rise over consecutive months.
 */
export async function monthlyTrendSeries(window: AnalyticsWindow): Promise<TrendSeries[]> {
  const rows = await prisma.$queryRaw<TrendRow[]>`
    ${BUILDING_CTE}
    SELECT
      date_trunc('month', c."createdAt") AS month,
      c."categoryKey" AS category_key,
      b.building_id,
      b.building_name,
      COUNT(*)::int AS count
    FROM "Complaint" c
    LEFT JOIN building b ON b.leaf = c."locationId"
    WHERE ${windowFilter(window)}
    GROUP BY 1, 2, 3, 4
    ORDER BY 1 ASC
  `;

  const months = monthsBetween(window);
  const grouped = new Map<string, TrendSeries>();

  for (const row of rows) {
    const key = `${row.category_key}::${row.building_id ?? 'campus'}`;
    let series = grouped.get(key);
    if (!series) {
      series = {
        categoryKey: row.category_key,
        categoryLabel: getCategory(row.category_key)?.label ?? row.category_key,
        locationId: row.building_id,
        locationName: row.building_name,
        months: months.map((month) => ({ month, count: 0 })),
      };
      grouped.set(key, series);
    }
    const bucket = series.months.find((m) => sameMonth(m.month, row.month));
    if (bucket) bucket.count += row.count;
  }

  return [...grouped.values()];
}

function monthsBetween(window: AnalyticsWindow): Date[] {
  const months: Date[] = [];
  const cursor = new Date(Date.UTC(window.from.getUTCFullYear(), window.from.getUTCMonth(), 1));
  const last = new Date(Date.UTC(window.to.getUTCFullYear(), window.to.getUTCMonth(), 1));
  while (cursor.getTime() <= last.getTime()) {
    months.push(new Date(cursor.getTime()));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

function sameMonth(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth();
}

/** Complaints per day across the window — the sparkline under §31's KPI row. */
export async function dailyVolume(
  window: AnalyticsWindow,
  departmentId?: string | null,
): Promise<{ day: Date; count: number }[]> {
  const rows = await prisma.$queryRaw<{ day: Date; count: number }[]>`
    SELECT date_trunc('day', c."createdAt") AS day, COUNT(*)::int AS count
    FROM "Complaint" c
    WHERE ${windowFilter(window, departmentId)}
    GROUP BY 1
    ORDER BY 1 ASC
  `;
  return rows;
}

// ---------------------------------------------------------------- §29 / §32 extras

/** The bands a department is carrying right now — §32's first four lines. */
export async function openByPriority(departmentId?: string | null): Promise<Record<Priority, number>> {
  const rows = await prisma.$queryRaw<{ priority: Priority; count: number }[]>`
    SELECT c."priority" AS priority, COUNT(*)::int AS count
    FROM "Complaint" c
    WHERE NOT ${SETTLED}
      ${departmentId ? Prisma.sql`AND c."departmentId" = ${departmentId}` : Prisma.empty}
    GROUP BY c."priority"
  `;

  const counts: Record<Priority, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const row of rows) counts[row.priority] = row.count;
  return counts;
}

/**
 * §29's "most problematic locations / most common categories", and the incidents
 * that affected the most people — the list an administrator reads top-down.
 */
export async function biggestIncidents(
  window: AnalyticsWindow,
  limit = 5,
): Promise<{ id: string; code: string; title: string; affectedCount: number; status: string; priority: Priority }[]> {
  return prisma.$queryRaw`
    SELECT i."id", i."code", i."title", i."affectedCount"::int AS "affectedCount", i."status"::text AS status, i."priority" AS priority
    FROM "Incident" i
    WHERE i."createdAt" >= ${window.from} AND i."createdAt" <= ${window.to}
    ORDER BY i."affectedCount" DESC, i."createdAt" DESC
    LIMIT ${limit}
  `;
}

/** §29's "frequently reopened complaints" — the ones a fix did not hold on. */
export async function mostReopened(
  window: AnalyticsWindow,
  limit = 5,
): Promise<{ id: string; code: string; title: string; reopenCount: number; status: string }[]> {
  return prisma.$queryRaw`
    SELECT c."id", c."code", c."title", c."reopenCount"::int AS "reopenCount", c."status"::text AS status
    FROM "Complaint" c
    WHERE ${windowFilter(window)} AND c."reopenCount" > 0
    ORDER BY c."reopenCount" DESC, c."createdAt" DESC
    LIMIT ${limit}
  `;
}

/** Monthly counts for the whole campus — the trend line on §31's overview. */
export async function monthlyTotals(
  window: AnalyticsWindow,
  departmentId?: string | null,
): Promise<MonthlyCount[]> {
  const rows = await prisma.$queryRaw<{ month: Date; count: number }[]>`
    SELECT date_trunc('month', c."createdAt") AS month, COUNT(*)::int AS count
    FROM "Complaint" c
    WHERE ${windowFilter(window, departmentId)}
    GROUP BY 1
    ORDER BY 1 ASC
  `;

  const filled = monthsBetween(window).map((month) => ({ month, count: 0 }));
  for (const row of rows) {
    const bucket = filled.find((m) => sameMonth(m.month, row.month));
    if (bucket) bucket.count = row.count;
  }
  return filled;
}
