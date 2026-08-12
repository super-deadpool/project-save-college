/**
 * The Layer 10 gate, run with no LLM available (plan.MD §9.5).
 *
 *   GROQ_API_KEY= npx tsx scripts/layer10-nokey.ts
 *
 * Analytics has no LLM in it at all — §33's narratives are Layer 12 — so this
 * gate is about a different kind of trust: **do the aggregations agree with the
 * modules that decide the same things one row at a time?**
 *
 *   · §31's totals are recounted against Prisma, complaint by complaint;
 *   · the SQL breach count is recounted with `sla/breach.ts`, which is the one
 *     place a dashboard could quietly disagree with the escalation ladder;
 *   · §28's heatmap is recounted by walking the location tree in TypeScript,
 *     rather than trusting the recursive CTE that rolls rooms up to buildings;
 *   · §34's score is recomputed from the totals and must match to the point;
 *   · §27/§30 are driven end to end over a **temporary** escalating trend the
 *     gate creates and deletes: the SQL half of the detector cannot be gated by
 *     unit tests, and there is no demo history in this database (plan.MD §7
 *     Layer 10 — the ~800-row seed was deliberately dropped).
 *
 * `scripts/layer10-gate.sh` checks the same figures over the API and the RBAC
 * around them.
 */
import 'dotenv/config';
import { prisma } from '@/lib/db';
import { getLlmProvider } from '@/lib/llm';
import { campusOverview, scanRecurring } from '@/lib/analytics/service';
import { lastMonths, locationDensity, monthlyTrendSeries, overviewTotals } from '@/lib/analytics/sql';
import { detectRecurring } from '@/lib/analytics/recurring';
import { healthScore } from '@/lib/analytics/health';
import { heatmap } from '@/lib/analytics/heatmap';
import { satisfactionOf } from '@/lib/feedback/satisfaction';
import { slaOutcome, slaState } from '@/lib/sla/breach';
import { SETTLED_STATUSES } from '@/lib/lifecycle/machine';
import { ancestryIndex } from '@/lib/locations';

const problems: string[] = [];
const check = (ok: boolean, failure: string) => {
  if (!ok) problems.push(failure);
};

/** Fixture rows carry their own code prefix so cleanup can never guess wrong. */
const FIXTURE_PREFIX = 'L10';

async function main() {
  if (getLlmProvider().available) {
    throw new Error('GROQ_API_KEY is set — rerun as `GROQ_API_KEY= npx tsx scripts/layer10-nokey.ts`');
  }
  console.log('provider: null (no key) — analytics never consults an LLM (§33 is Layer 12)\n');

  await cleanupFixture();

  try {
    await checkTotals();
    await checkHeatmap();
    await checkHealth();
    await checkRecurring();
  } finally {
    await cleanupFixture();
  }

  console.log();
  for (const problem of problems) console.log(`  FAIL: ${problem}`);
  console.log(
    problems.length === 0
      ? 'gate: every dashboard figure recounts to the same number the row-level modules give, and §27 → §30 runs end to end over a real trend'
      : `gate: ${problems.length} failure(s)`,
  );

  await prisma.$disconnect();
  process.exit(problems.length === 0 ? 0 : 1);
}

// ---------------------------------------------------------------- §31

async function checkTotals() {
  console.log('── §31: the overview, recounted row by row');
  const window = lastMonths(6);
  const totals = await overviewTotals(window);

  const rows = await prisma.complaint.findMany({
    where: { createdAt: { gte: window.from, lte: window.to } },
    select: {
      status: true,
      priority: true,
      createdAt: true,
      responseDueAt: true,
      resolutionDueAt: true,
      respondedAt: true,
      resolvedAt: true,
      closedAt: true,
      reopenCount: true,
      escalationLevel: true,
    },
  });

  const settled = (status: (typeof rows)[number]['status']) => SETTLED_STATUSES.includes(status);
  const expectedOpen = rows.filter((r) => !settled(r.status)).length;
  const expectedCritical = rows.filter((r) => !settled(r.status) && r.priority === 'CRITICAL').length;
  const expectedReopened = rows.filter((r) => r.reopenCount > 0).length;

  console.log(
    `   ${totals.total} complaints · ${totals.open} open · ${totals.openCritical} critical · ${totals.reopened} reopened`,
  );
  check(totals.total === rows.length, `SQL counted ${totals.total} complaints, Prisma sees ${rows.length}`);
  check(totals.open === expectedOpen, `SQL says ${totals.open} open, recount says ${expectedOpen}`);
  check(
    totals.openCritical === expectedCritical,
    `SQL says ${totals.openCritical} open criticals, recount says ${expectedCritical}`,
  );
  check(
    totals.reopened === expectedReopened,
    `SQL says ${totals.reopened} reopened, recount says ${expectedReopened}`,
  );

  // The one that matters most: the compliance figure on the dashboard and the
  // ladder the worker climbs must be reading the same complaints as "late".
  const now = new Date();
  const withDeadline = rows.filter((r) => r.responseDueAt != null || r.resolutionDueAt != null);
  const lateByModule = withDeadline.filter((row) => {
    const outcome = slaOutcome(row);
    const live = slaState(row, now);
    return (
      outcome.responseMet === false ||
      outcome.resolutionMet === false ||
      live.responseBreached ||
      live.resolutionBreached
    );
  }).length;

  console.log(
    `   ${totals.withDeadline} carry a promise · SQL says ${totals.breached} broke it · sla/breach.ts says ${lateByModule}`,
  );
  check(
    totals.withDeadline === withDeadline.length,
    `SQL says ${totals.withDeadline} have deadlines, recount says ${withDeadline.length}`,
  );
  check(
    totals.breached === lateByModule,
    `the dashboard's breach count (${totals.breached}) disagrees with sla/breach.ts (${lateByModule})`,
  );

  const ratings = (
    await prisma.feedback.findMany({
      where: { complaint: { createdAt: { gte: window.from, lte: window.to } } },
      select: { rating: true },
    })
  ).map((f) => f.rating);
  const satisfaction = satisfactionOf(ratings);
  const overview = await campusOverview(6);
  console.log(
    `   satisfaction ${overview.satisfaction.average?.toFixed(2) ?? '—'} over ${overview.satisfaction.count} ratings`,
  );
  check(
    overview.satisfaction.count === satisfaction.count,
    `the dashboard counts ${overview.satisfaction.count} ratings, the table holds ${satisfaction.count}`,
  );
  check(
    overview.satisfaction.average === satisfaction.average,
    'the dashboard average differs from the same ratings averaged directly',
  );

  // §31's distribution must add up to the whole, or a share is meaningless.
  const shareTotal = overview.categories.reduce((sum, c) => sum + c.share, 0);
  const countTotal = overview.categories.reduce((sum, c) => sum + c.count, 0);
  console.log(
    `   ${overview.categories.length} categories · shares sum to ${shareTotal.toFixed(3)} · counts sum to ${countTotal}`,
  );
  check(Math.abs(shareTotal - 1) < 1e-9 || countTotal === 0, `category shares sum to ${shareTotal}, not 1`);
  check(countTotal === totals.total, `category counts sum to ${countTotal}, total is ${totals.total}`);

  // The department table is the same complaints, sliced by owner.
  const deptTotal = overview.departments.reduce((sum, d) => sum + d.total, 0);
  const unrouted = await prisma.complaint.count({
    where: { createdAt: { gte: window.from, lte: window.to }, departmentId: null },
  });
  console.log(`   ${deptTotal} routed + ${unrouted} awaiting triage = ${deptTotal + unrouted}`);
  check(
    deptTotal + unrouted === totals.total,
    `the department table accounts for ${deptTotal + unrouted} of ${totals.total} complaints`,
  );
}

// ---------------------------------------------------------------- §28

async function checkHeatmap() {
  console.log('\n── §28: the heatmap, recounted by walking the location tree');
  const window = lastMonths(6);
  const density = await locationDensity(window);
  const cells = heatmap(density);

  // The CTE rolls a room up to its building; this does the same in TypeScript.
  const [locations, index, complaints] = await Promise.all([
    prisma.location.findMany({ select: { id: true, name: true, parentId: true } }),
    ancestryIndex(),
    prisma.complaint.findMany({
      where: { createdAt: { gte: window.from, lte: window.to }, locationId: { not: null } },
      select: { locationId: true },
    }),
  ]);
  const parentOf = new Map(locations.map((l) => [l.id, l.parentId]));
  const nameOf = new Map(locations.map((l) => [l.id, l.name]));
  const rootId = locations.find((l) => l.parentId == null)?.id ?? null;

  const expected = new Map<string, number>();
  for (const complaint of complaints) {
    const chain = index.get(complaint.locationId!) ?? [];
    // The building is the ancestor whose own parent is the campus root.
    const building = chain.find((id) => parentOf.get(id) === rootId) ?? null;
    if (!building) continue;
    expected.set(building, (expected.get(building) ?? 0) + 1);
  }

  for (const cell of cells.slice(0, 5)) {
    console.log(
      `   ${cell.locationName.padEnd(22)} ${String(cell.total).padStart(3)} ${cell.level}${cell.open ? ` · ${cell.open} open` : ''}`,
    );
  }

  check(cells.length === expected.size, `the heatmap has ${cells.length} buildings, the recount found ${expected.size}`);
  for (const cell of cells) {
    const mine = expected.get(cell.locationId);
    check(
      mine === cell.total,
      `${cell.locationName}: the CTE counted ${cell.total}, walking the tree gives ${mine ?? 0}`,
    );
  }

  const busiest = cells[0];
  if (busiest && busiest.total > 0) {
    const recountBusiest = [...expected.entries()].sort((a, b) => b[1] - a[1])[0];
    console.log(`   busiest: ${busiest.locationName} (${busiest.total}) · recount: ${nameOf.get(recountBusiest[0])} (${recountBusiest[1]})`);
    check(
      busiest.total === recountBusiest[1],
      `the map's busiest building has ${busiest.total} complaints, the recount's has ${recountBusiest[1]}`,
    );
    // The busiest place on a campus with real volume is the one §28 paints red.
    check(
      busiest.level === 'HIGH' || busiest.total < 3,
      `${busiest.locationName} is the busiest building at ${busiest.total} complaints but is banded ${busiest.level}`,
    );
  }
}

// ---------------------------------------------------------------- §34

async function checkHealth() {
  console.log('\n── §34: the score, recomputed from the numbers it claims to use');
  const overview = await campusOverview(6);
  const { totals, satisfaction, health } = overview;

  const recomputed = healthScore({
    openCritical: totals.openCritical,
    slaBreachRate: totals.withDeadline === 0 ? 0 : totals.breached / totals.withDeadline,
    reopenRate: totals.reopenRate,
    recurringAct: overview.recurring.filter((r) => r.severity === 'ACT').length,
    recurringWatch: overview.recurring.filter((r) => r.severity === 'WATCH').length,
    satisfactionAverage: satisfaction.average,
    volume: totals.total,
  });

  console.log(`   ${health.score}/100 (${health.band}) · recomputed ${recomputed.score}`);
  for (const term of health.terms) {
    console.log(`   ${term.points >= 0 ? '+' : ''}${term.points.toFixed(1)}  ${term.label} — ${term.detail}`);
  }
  check(health.score === recomputed.score, `the dashboard shows ${health.score}, the formula gives ${recomputed.score}`);
  // §14's rule, applied to §34: never a bare number.
  check(health.terms.length === 5, `the score is shown with ${health.terms.length} terms, expected 5`);
  check(
    health.terms.every((t) => t.detail.trim().length > 0),
    'a health term carries points with no evidence behind them',
  );
  check(
    overview.categoryHealth.every((c) => c.health.terms.length === 5),
    'a category score is shown without its terms',
  );
  const worst = overview.categoryHealth[0];
  if (worst) {
    console.log(`   worst category: ${worst.label} at ${worst.health.score} over ${worst.volume} complaints`);
    check(
      overview.categoryHealth.every((c, i, arr) => i === 0 || arr[i - 1].health.score <= c.health.score),
      'the category scores are not ordered worst first',
    );
  }
}

// ---------------------------------------------------------------- §27 / §30

/**
 * The only part of this layer that needs history to exist: a rising trend across
 * four months. The database has none — every complaint in it was filed today —
 * so the gate creates one, drives §27 and §30 over it, and deletes it again.
 *
 * The rows are deliberately minimal and settled (CLOSED), sharing one incident so
 * the "every complaint has exactly one incident" invariant holds, and they carry
 * an `L10-` code prefix so cleanup is exact rather than heuristic.
 */
async function checkRecurring() {
  console.log('\n── §27 and §30, over a trend the gate creates and then removes');

  const before = await scanRecurring();
  console.log(`   live database first: ${before.detected} trend(s) — all history is inside one month`);

  const [reporter, location] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { email: 'student@campus.edu' }, select: { id: true } }),
    prisma.location.findUniqueOrThrow({ where: { code: 'ECE-LAB1' }, select: { id: true, name: true } }),
  ]);

  const shape = [4, 6, 9, 14];
  const incident = await prisma.incident.create({
    data: {
      code: `${FIXTURE_PREFIX}-INC`,
      title: 'Gate fixture: recurring lab equipment failures',
      categoryKey: 'LAB_OTHER',
      locationId: location.id,
      status: 'CLOSED',
      affectedCount: 1,
      resolvedAt: new Date(),
    },
  });

  let n = 0;
  const now = new Date();
  for (const [monthsAgo, count] of shape.map((c, i) => [shape.length - 1 - i, c] as const)) {
    for (let i = 0; i < count; i++) {
      n += 1;
      // Midnight, and never later than today: the analytics window ends at
      // "now", so a row dated the 20th of this month would simply be invisible.
      const latestDay = monthsAgo === 0 ? now.getUTCDate() : 28;
      const day = Math.min(1 + (i % 20), latestDay);
      const createdAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, day));
      await prisma.complaint.create({
        data: {
          code: `${FIXTURE_PREFIX}-${String(n).padStart(4, '0')}`,
          title: 'Gate fixture: lab bench equipment failed again',
          description: 'Fixture row for the Layer 10 gate. Deleted before the gate exits.',
          categoryKey: 'LAB_OTHER',
          locationId: location.id,
          reporterId: reporter.id,
          incidentId: incident.id,
          status: 'CLOSED',
          priority: 'MEDIUM',
          createdAt,
          resolvedAt: createdAt,
          closedAt: createdAt,
        },
      });
    }
  }
  console.log(`   fixture: ${n} complaints in ${location.name} across ${shape.length} months (${shape.join(' → ')})`);

  // The SQL half: does the trend query see the shape that was written?
  const window = lastMonths(shape.length);
  const series = await monthlyTrendSeries(window);
  const mine = series.find((s) => s.categoryKey === 'LAB_OTHER' && s.locationName === 'ECE Block');
  if (!mine) {
    problems.push('the trend query did not roll the fixture up to its building at all');
  } else {
    const counts = mine.months.map((m) => m.count);
    console.log(`   monthlyTrendSeries: ${counts.join(' → ')} (zero-filled, oldest first)`);
    check(
      counts.slice(-shape.length).join(',') === shape.join(','),
      `the trend query read ${counts.join(',')} where the fixture wrote ${shape.join(',')}`,
    );
  }

  const signals = detectRecurring(series);
  const signal = signals.find((s) => s.categoryKey === 'LAB_OTHER');
  if (!signal) {
    problems.push('§27 did not detect a trend that rose 4 → 6 → 9 → 14 over four months');
  } else {
    console.log(`   §27: ${signal.severity} · ${signal.growthLabel} · ${signal.narrative}`);
    console.log(`   §30: ${signal.suggestion}`);
    check(signal.occurrences === n, `the signal counts ${signal.occurrences} complaints, the fixture wrote ${n}`);
    check(signal.risingMonths === shape.length - 1, `the signal saw ${signal.risingMonths} consecutive rises, expected ${shape.length - 1}`);
    check(signal.severity === 'ACT', `a sustained climb was rated ${signal.severity}`);
    check(signal.locationName === 'ECE Block', `the signal points at ${signal.locationName}, not the building`);
    check(/inspect|service|review|audit|investigate/i.test(signal.suggestion), '§30 produced no actionable suggestion');
    check(signal.narrative.includes('14'), 'the narrative does not state the latest monthly figure');
  }

  // The persistence half, and its idempotency (§30 runs nightly *and* on demand).
  const first = await scanRecurring(shape.length);
  const second = await scanRecurring(shape.length);
  const stored = await prisma.recurringSignal.count({ where: { categoryKey: 'LAB_OTHER' } });
  console.log(
    `   scan: ${first.detected} detected, ${first.written} written, ${first.refreshed} refreshed · rescan: ${second.written} written, ${second.refreshed} refreshed`,
  );
  check(first.written >= 1, 'the scan detected a trend but stored nothing (§30)');
  check(second.written === 0, `a rescan wrote ${second.written} duplicate signal row(s)`);
  check(second.refreshed >= 1, 'a rescan neither wrote nor refreshed the signal it had already found');
  check(stored === 1, `${stored} rows stored for one trend, expected 1`);

  const row = await prisma.recurringSignal.findFirst({ where: { categoryKey: 'LAB_OTHER' } });
  check(row?.suggestion != null && row.suggestion.length > 0, 'the stored signal has no suggestion to act on');
  check(row?.narrative != null, 'the stored signal has no narrative');
  check(row?.occurrences === n, `the stored signal records ${row?.occurrences} complaints, the fixture wrote ${n}`);
}

/** Exact cleanup by code prefix, so a failed run cannot leave the DB dirty. */
async function cleanupFixture() {
  const complaints = await prisma.complaint.deleteMany({
    where: { code: { startsWith: `${FIXTURE_PREFIX}-` } },
  });
  const incidents = await prisma.incident.deleteMany({
    where: { code: { startsWith: `${FIXTURE_PREFIX}-` } },
  });
  const signals = await prisma.recurringSignal.deleteMany({ where: { categoryKey: 'LAB_OTHER' } });

  if (complaints.count + incidents.count + signals.count > 0) {
    console.log(
      `cleanup: removed ${complaints.count} fixture complaint(s), ${incidents.count} incident(s), ${signals.count} signal row(s)`,
    );
  }
}

main().catch(async (error) => {
  console.error(error);
  await cleanupFixture().catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});
