import { prisma } from '@/lib/db';
import { satisfactionOf, type Satisfaction } from '@/lib/feedback/satisfaction';
import { queueBucket, slaRisk, sortQueue } from '@/lib/queue/rank';
import { getCategory } from '@/lib/engine/schemas';
import { detectRecurring, type RecurringSignal, type MonthlyCount } from './recurring';
import { heatmap, heatmapHeadline, type HeatCell } from './heatmap';
import { healthScore, type HealthScore } from './health';
import {
  biggestIncidents,
  categoryDistribution,
  dailyVolume,
  departmentPerformance,
  EMPTY_TOTALS,
  lastDays,
  lastMonths,
  locationDensity,
  monthlyTotals,
  monthlyTrendSeries,
  mostReopened,
  openByPriority,
  overviewTotals,
  overviewTotalsByCategory,
  ratingsIn,
  type AnalyticsWindow,
  type CategoryShare,
  type DepartmentPerformance,
  type OverviewTotals,
} from './sql';
import type { Priority } from '@/generated/prisma/enums';

/**
 * The composition layer: SQL rows (from `sql.ts`) meet the pure scorers
 * (`recurring.ts`, `heatmap.ts`, `health.ts`) and become the two dashboards §31
 * and §32 describe.
 *
 * Every number a page shows is assembled here rather than in the page, so the API
 * and the server components render exactly the same figures — the same discipline
 * `assess.ts` enforces for priority.
 */

export const DEFAULT_MONTHS = 6;

export interface CampusOverview {
  window: AnalyticsWindow;
  totals: OverviewTotals;
  satisfaction: Satisfaction;
  categories: CategoryShare[];
  departments: DepartmentPerformance[];
  heat: HeatCell[];
  heatHeadline: string | null;
  recurring: RecurringSignal[];
  health: HealthScore;
  /** Health per category, so a good average cannot hide one bad service (§34). */
  categoryHealth: { categoryKey: string; label: string; health: HealthScore; volume: number }[];
  trend: MonthlyCount[];
  daily: { day: Date; count: number }[];
  incidents: Awaited<ReturnType<typeof biggestIncidents>>;
  reopened: Awaited<ReturnType<typeof mostReopened>>;
}

export async function campusOverview(months = DEFAULT_MONTHS): Promise<CampusOverview> {
  const window = lastMonths(months);

  const [totals, ratings, categories, departments, density, series, trend, daily, incidents, reopened] =
    await Promise.all([
      overviewTotals(window),
      ratingsIn(window),
      categoryDistribution(window),
      departmentPerformance(window),
      locationDensity(window),
      monthlyTrendSeries(window),
      monthlyTotals(window),
      // A rolling 30 days, which is what the sparkline underneath the trend says
      // it is — a calendar month would make it a two-day line on the 2nd.
      dailyVolume(lastDays(30)),
      biggestIncidents(window),
      mostReopened(window),
    ]);

  const satisfaction = satisfactionOf(ratings);
  const recurring = detectRecurring(series);
  const heat = heatmap(density);

  const health = healthScore({
    openCritical: totals.openCritical,
    slaBreachRate: totals.withDeadline === 0 ? 0 : totals.breached / totals.withDeadline,
    reopenRate: totals.reopenRate,
    recurringAct: recurring.filter((r) => r.severity === 'ACT').length,
    recurringWatch: recurring.filter((r) => r.severity === 'WATCH').length,
    satisfactionAverage: satisfaction.average,
    volume: totals.total,
  });

  const categoryHealth = await categoryHealthScores(window, categories, recurring);

  return {
    window,
    totals,
    satisfaction,
    categories,
    departments,
    heat,
    heatHeadline: heatmapHeadline(heat),
    recurring,
    health,
    categoryHealth,
    trend,
    daily,
    incidents,
    reopened,
  };
}

/**
 * §34's category-level scores. Each one is the same formula over that category's
 * own slice — a campus can be healthy on average while its water supply is not,
 * and the average is exactly what hides that.
 */
async function categoryHealthScores(
  window: AnalyticsWindow,
  categories: CategoryShare[],
  recurring: RecurringSignal[],
): Promise<CampusOverview['categoryHealth']> {
  // Only the categories that actually saw complaints — a score of 100 for a
  // category nobody reported is a fact about the report, not the campus.
  const present = categories.filter((c) => c.count > 0).slice(0, 8);
  // Both halves in one query each, then sliced per category in memory.
  const [totalsByCategory, ratingsByCategory] = await Promise.all([
    overviewTotalsByCategory(window),
    ratingsByCategoryIn(window),
  ]);

  const scores = await Promise.all(
    present.map(async (category) => {
      const totals = totalsByCategory.get(category.categoryKey) ?? EMPTY_TOTALS;
      const satisfaction = satisfactionOf(ratingsByCategory.get(category.categoryKey) ?? []);
      const signals = recurring.filter((r) => r.categoryKey === category.categoryKey);

      return {
        categoryKey: category.categoryKey,
        label: category.label,
        volume: totals.total,
        health: healthScore({
          openCritical: totals.openCritical,
          slaBreachRate: totals.withDeadline === 0 ? 0 : totals.breached / totals.withDeadline,
          reopenRate: totals.reopenRate,
          recurringAct: signals.filter((s) => s.severity === 'ACT').length,
          recurringWatch: signals.filter((s) => s.severity === 'WATCH').length,
          satisfactionAverage: satisfaction.average,
          volume: totals.total,
        }),
      };
    }),
  );

  return scores.sort((a, b) => a.health.score - b.health.score);
}

/** Every rating in the window, grouped by the category it was given to. */
async function ratingsByCategoryIn(window: AnalyticsWindow): Promise<Map<string, number[]>> {
  const rows = await prisma.$queryRaw<{ category_key: string; rating: number }[]>`
    SELECT c."categoryKey" AS category_key, f."rating"::int AS rating
    FROM "Feedback" f
    JOIN "Complaint" c ON c."id" = f."complaintId"
    WHERE c."createdAt" >= ${window.from} AND c."createdAt" <= ${window.to}
  `;

  const byCategory = new Map<string, number[]>();
  for (const row of rows) {
    const list = byCategory.get(row.category_key) ?? [];
    list.push(row.rating);
    byCategory.set(row.category_key, list);
  }
  return byCategory;
}

// ---------------------------------------------------------------- §32

export interface DepartmentDashboard {
  window: AnalyticsWindow;
  department: { id: string; name: string; code: string };
  totals: OverviewTotals;
  satisfaction: Satisfaction;
  openByPriority: Record<Priority, number>;
  /** §32's "SLA At Risk: 5" — approaching or already past a deadline. */
  atRisk: number;
  breachedNow: number;
  escalated: number;
  categories: CategoryShare[];
  /** "Most common issue: Wi-Fi outages". */
  commonIssue: { label: string; count: number } | null;
  /** "What needs attention right now?" — the top of that department's queue. */
  attention: {
    id: string;
    code: string;
    title: string;
    priority: Priority;
    status: string;
    risk: string;
    escalationLevel: number;
    dueAt: Date | null;
  }[];
  trend: MonthlyCount[];
  health: HealthScore;
  recurring: RecurringSignal[];
}

export async function departmentDashboard(
  departmentId: string,
  months = DEFAULT_MONTHS,
): Promise<DepartmentDashboard | null> {
  const window = lastMonths(months);
  const department = await prisma.department.findUnique({
    where: { id: departmentId },
    select: { id: true, name: true, code: true },
  });
  if (!department) return null;

  const [totals, ratings, categories, bands, trend, series, open] = await Promise.all([
    overviewTotals(window, departmentId),
    ratingsIn(window, departmentId),
    categoryDistribution(window, departmentId),
    openByPriority(departmentId),
    monthlyTotals(window, departmentId),
    monthlyTrendSeries(window),
    // The live queue, not a window: "right now" is the question §32 asks.
    prisma.complaint.findMany({
      where: { departmentId, status: { notIn: ['RESOLVED', 'CLOSED', 'REJECTED', 'DUPLICATE'] } },
      select: {
        id: true,
        code: true,
        title: true,
        priority: true,
        priorityScore: true,
        status: true,
        createdAt: true,
        responseDueAt: true,
        resolutionDueAt: true,
        respondedAt: true,
        escalationLevel: true,
      },
      take: 200,
    }),
  ]);

  const now = new Date();
  // The same pure functions the queue page ranks with, so §32's "what needs
  // attention" cannot disagree with §21's ordering.
  const ranked = sortQueue(open, now);
  const risks = ranked.map((row) => ({ row, risk: slaRisk(row, now) }));

  const satisfaction = satisfactionOf(ratings);
  const recurring = detectRecurring(series).filter((signal) =>
    categories.some((c) => c.categoryKey === signal.categoryKey),
  );

  return {
    window,
    department,
    totals,
    satisfaction,
    openByPriority: bands,
    atRisk: risks.filter((r) => r.risk === 'AT_RISK' || r.risk === 'BREACHED').length,
    breachedNow: risks.filter((r) => r.risk === 'BREACHED').length,
    escalated: ranked.filter((r) => r.escalationLevel > 0).length,
    categories,
    commonIssue: categories[0] ? { label: categories[0].label, count: categories[0].count } : null,
    attention: risks.slice(0, 8).map(({ row, risk }) => ({
      id: row.id,
      code: row.code,
      title: row.title,
      priority: row.priority,
      status: row.status,
      risk,
      escalationLevel: row.escalationLevel,
      dueAt: row.respondedAt ? row.resolutionDueAt : (row.responseDueAt ?? row.resolutionDueAt),
    })),
    trend,
    health: healthScore({
      openCritical: totals.openCritical,
      slaBreachRate: totals.withDeadline === 0 ? 0 : totals.breached / totals.withDeadline,
      reopenRate: totals.reopenRate,
      recurringAct: recurring.filter((r) => r.severity === 'ACT').length,
      recurringWatch: recurring.filter((r) => r.severity === 'WATCH').length,
      satisfactionAverage: satisfaction.average,
      volume: totals.total,
    }),
    recurring,
  };
}

/** Bucket counts for the queue's own header — reuses §21's pure bucketing. */
export function queueShape<T extends Parameters<typeof queueBucket>[0]>(rows: T[], now: Date) {
  const shape = { CRITICAL: 0, HIGH: 0, AT_RISK: 0, NORMAL: 0, DONE: 0 };
  for (const row of rows) shape[queueBucket(row, now)] += 1;
  return shape;
}

// ---------------------------------------------------------------- §30 persistence

export interface RecurringScanResult {
  detected: number;
  written: number;
  refreshed: number;
  signals: RecurringSignal[];
}

/**
 * §30 — persist what §27 detected, so a preventive-maintenance suggestion is a
 * record somebody can acknowledge rather than a sentence that vanishes on the
 * next page load.
 *
 * Idempotent per (category, location, window end): rescanning the same month
 * updates that month's row instead of stacking a new one, which is what makes it
 * safe to run from the worker every night and from the admin button in between.
 */
export async function scanRecurring(months = DEFAULT_MONTHS): Promise<RecurringScanResult> {
  const window = lastMonths(months);
  const series = await monthlyTrendSeries(window);
  const signals = detectRecurring(series);

  let written = 0;
  let refreshed = 0;

  for (const signal of signals) {
    const existing = await prisma.recurringSignal.findFirst({
      where: {
        categoryKey: signal.categoryKey,
        locationId: signal.locationId,
        windowEnd: signal.windowEnd,
      },
      select: { id: true },
    });

    const data = {
      categoryKey: signal.categoryKey,
      locationId: signal.locationId,
      windowStart: signal.windowStart,
      windowEnd: signal.windowEnd,
      occurrences: signal.occurrences,
      growthRate: signal.growthRate,
      suggestion: signal.suggestion,
      narrative: signal.narrative,
    };

    if (existing) {
      await prisma.recurringSignal.update({ where: { id: existing.id }, data });
      refreshed += 1;
    } else {
      await prisma.recurringSignal.create({ data });
      written += 1;
    }
  }

  return { detected: signals.length, written, refreshed, signals };
}

/** The stored signals, newest first — what the dashboard panel lists. */
export async function storedRecurringSignals(limit = 10) {
  const rows = await prisma.recurringSignal.findMany({
    orderBy: [{ windowEnd: 'desc' }, { growthRate: 'desc' }],
    take: limit,
  });

  const locationIds = [...new Set(rows.map((r) => r.locationId).filter((id): id is string => id != null))];
  const locations = await prisma.location.findMany({
    where: { id: { in: locationIds } },
    select: { id: true, name: true },
  });
  const nameById = new Map(locations.map((l) => [l.id, l.name]));

  return rows.map((row) => ({
    id: row.id,
    categoryKey: row.categoryKey,
    categoryLabel: getCategory(row.categoryKey)?.label ?? row.categoryKey,
    locationName: row.locationId ? (nameById.get(row.locationId) ?? null) : null,
    occurrences: row.occurrences,
    growthRate: row.growthRate,
    narrative: row.narrative,
    suggestion: row.suggestion,
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
    acknowledgedAt: row.acknowledgedAt,
  }));
}
