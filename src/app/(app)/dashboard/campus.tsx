import Link from 'next/link';
import { campusOverview, storedRecurringSignals } from '@/lib/analytics/service';
import { count, duration, monthLabel, percent, rating } from '@/lib/analytics/format';
import {
  BarList,
  HealthPanel,
  HeatGrid,
  Meter,
  MonthBars,
  RatingHistogram,
  Sparkline,
  StatTile,
} from '@/components/charts';
import { PriorityBadge } from '@/components/badges';
import { ScanRecurring } from './scan-recurring';

/**
 * §31's admin dashboard, plus §28's heatmap, §27/§30's recurring signals and
 * §34's health score — the campus in one screen.
 *
 * Every figure comes from `analytics/service.ts`, which is also what the API
 * returns, so a number here can be checked against the endpoint and against the
 * SQL underneath it. Nothing is computed in this file.
 */
export async function CampusDashboard() {
  const [overview, stored] = await Promise.all([campusOverview(), storedRecurringSignals()]);
  const { totals, satisfaction, health } = overview;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Campus overview</h1>
        <p className="mt-1 text-sm text-muted">
          {monthLabel(overview.window.from, 'long')} to today · {count(totals.total)} complaints
        </p>
      </div>

      {/* §31's overview row. Seven numbers, each one a question an administrator
          arrives with. */}
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Total complaints" value={count(totals.total)} hint={`${count(totals.resolved)} resolved`} />
        <StatTile
          label="Open"
          value={count(totals.open)}
          hint={`${count(totals.openCritical)} critical`}
          tone={totals.openCritical > 0 ? 'warning' : 'plain'}
        />
        <StatTile
          label="Critical open"
          value={count(totals.openCritical)}
          hint="Unresolved at the top band"
          tone={totals.openCritical > 0 ? 'critical' : 'good'}
        />
        <StatTile
          label="Avg resolution time"
          value={duration(totals.avgResolutionHours)}
          hint={`response ${totals.avgResponseMinutes == null ? '—' : duration(totals.avgResponseMinutes / 60)}`}
        />
        <StatTile
          label="SLA compliance"
          value={percent(totals.slaCompliance)}
          hint={`${count(totals.breached)} of ${count(totals.withDeadline)} missed a deadline`}
          tone={
            totals.slaCompliance == null
              ? 'plain'
              : totals.slaCompliance >= 0.9
                ? 'good'
                : totals.slaCompliance >= 0.7
                  ? 'warning'
                  : 'critical'
          }
        />
        <StatTile
          label="Student satisfaction"
          value={rating(satisfaction.average)}
          hint={`${count(satisfaction.count)} rated`}
        />
        <StatTile
          label="Reopened"
          value={percent(totals.reopenRate)}
          hint={`${count(totals.reopened)} came back after a fix`}
          tone={totals.reopenRate > 0.2 ? 'warning' : 'plain'}
        />
        <StatTile label="Closed" value={count(totals.closed)} hint="Confirmed by the student" />
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-lg border border-line bg-surface p-5">
          <h2 className="text-sm font-medium">Complaints per month</h2>
          <MonthBars months={overview.trend} caption="The current month is still filling up." />
          <Sparkline points={overview.daily} caption="Daily volume, last 30 days" />
        </section>

        {/* §34 — the number and the arithmetic behind it, together. */}
        <section className="rounded-lg border border-line bg-surface p-5">
          <h2 className="text-sm font-medium">Campus health</h2>
          <div className="mt-2">
            <HealthPanel health={health} />
          </div>
        </section>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* §31's distribution. */}
        <section className="rounded-lg border border-line bg-surface p-5">
          <h2 className="text-sm font-medium">Where the complaints come from</h2>
          <p className="mt-1 text-xs text-muted">Share of the window, by category</p>
          <div className="mt-3">
            <BarList
              items={overview.categories.map((c) => ({
                key: c.categoryKey,
                label: c.label,
                value: c.count,
                display: percent(c.share),
                hint: `${c.count} complaints · ${c.open} open · avg ${duration(c.avgResolutionHours)}`,
              }))}
            />
          </div>
        </section>

        {/* §28's heatmap, rolled up to buildings. */}
        <section className="rounded-lg border border-line bg-surface p-5">
          <h2 className="text-sm font-medium">Where on campus</h2>
          <p className="mt-1 text-xs text-muted">
            {overview.heatHeadline ?? 'Complaint density by building.'}
          </p>
          <div className="mt-3">
            <HeatGrid cells={overview.heat} />
          </div>
        </section>
      </div>

      {/* §31's department comparison — a table, because five measures per
          department is a table, and every measure has its own unit. */}
      <section className="rounded-lg border border-line bg-surface p-5">
        <h2 className="text-sm font-medium">Department performance</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[46rem] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th className="pb-2 font-normal">Department</th>
                <th className="pb-2 font-normal">Volume</th>
                <th className="pb-2 font-normal">Open</th>
                <th className="pb-2 font-normal">Avg resolution</th>
                <th className="pb-2 font-normal">SLA compliance</th>
                <th className="pb-2 font-normal">Satisfaction</th>
                <th className="pb-2 font-normal">Reopened</th>
              </tr>
            </thead>
            <tbody>
              {overview.departments.map((d) => (
                <tr key={d.departmentId} className="border-b border-line last:border-0">
                  <td className="py-2">
                    {d.name}
                    <span className="ml-2 font-mono text-xs text-muted">{d.code}</span>
                  </td>
                  <td className="py-2 tabular-nums">{count(d.total)}</td>
                  <td className="py-2 tabular-nums">
                    {count(d.open)}
                    {d.openCritical > 0 && (
                      <span className="ml-1 text-xs text-[var(--status-critical)]">
                        {d.openCritical} critical
                      </span>
                    )}
                  </td>
                  <td className="py-2 tabular-nums">{duration(d.avgResolutionHours)}</td>
                  <td className="py-2">
                    <Meter
                      fraction={d.slaCompliance}
                      label={`${d.breached} of ${d.withDeadline} missed a deadline`}
                    />
                  </td>
                  <td className="py-2 tabular-nums">
                    {rating(d.satisfaction)}
                    <span className="ml-1 text-xs text-muted">({d.ratings})</span>
                  </td>
                  <td className="py-2 tabular-nums">{count(d.reopened)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* §27 + §30 — the trend, and what to do about it. */}
      <section className="rounded-lg border border-line bg-surface p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium">Recurring issues</h2>
            <p className="mt-1 text-xs text-muted">
              Month-over-month growth per building and category, with what to inspect (§27, §30)
            </p>
          </div>
          <ScanRecurring />
        </div>

        {overview.recurring.length === 0 ? (
          <p className="mt-3 text-sm text-muted">
            No rising trends in this window. A trend needs sustained volume as well as growth, so a
            quiet campus says nothing here rather than inventing something.
          </p>
        ) : (
          <ul className="mt-3 space-y-3">
            {overview.recurring.map((signal) => (
              <li
                key={`${signal.categoryKey}-${signal.locationId ?? 'campus'}`}
                className="rounded-md border border-line p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      signal.severity === 'ACT' ? 'bg-red-100 text-red-900' : 'bg-amber-100 text-amber-900'
                    }`}
                  >
                    {signal.severity === 'ACT' ? 'Needs action' : 'Watch'}
                  </span>
                  <span className="text-sm font-medium">
                    {signal.categoryLabel} · {signal.locationName ?? 'Campus-wide'}
                  </span>
                  <span className="text-xs text-muted">
                    {signal.growthLabel} · {signal.occurrences} complaints
                  </span>
                </div>
                <p className="mt-1 text-sm">{signal.narrative}</p>
                <p className="mt-1 text-sm text-muted">{signal.suggestion}</p>
              </li>
            ))}
          </ul>
        )}

        {stored.length > 0 && (
          <details className="mt-4">
            <summary className="cursor-pointer text-xs text-muted">
              {stored.length} signal(s) recorded from earlier scans
            </summary>
            <ul className="mt-2 space-y-1 text-xs text-muted">
              {/* The stored row's own narrative, rather than a percentage
                  recomputed from a rate whose baseline is no longer in view. */}
              {stored.map((s) => (
                <li key={s.id} title={s.suggestion ?? undefined}>
                  {monthLabel(s.windowEnd, 'long')} · {s.categoryLabel} ·{' '}
                  {s.locationName ?? 'Campus-wide'} · {s.occurrences} complaints
                  {s.narrative ? ` — ${s.narrative}` : ''}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* §34's category scores: an average of 84 can hide a service at 51. */}
        <section className="rounded-lg border border-line bg-surface p-5">
          <h2 className="text-sm font-medium">Health by category</h2>
          <p className="mt-1 text-xs text-muted">Worst first — the campus average hides these</p>
          <div className="mt-3">
            <BarList
              items={overview.categoryHealth.map((c) => ({
                key: c.categoryKey,
                label: c.label,
                value: c.health.score,
                display: String(c.health.score),
                hint: c.health.terms.map((t) => `${t.label}: ${t.detail}`).join(' · '),
              }))}
              emptyNote="No complaints in this window."
            />
          </div>
        </section>

        <section className="rounded-lg border border-line bg-surface p-5">
          <h2 className="text-sm font-medium">Student satisfaction</h2>
          <p className="mt-1 text-xs text-muted">
            {satisfaction.count === 0
              ? 'Nothing rated yet.'
              : `${rating(satisfaction.average)} across ${count(satisfaction.count)} ratings · ${percent(satisfaction.positiveRate)} positive`}
          </p>
          <RatingHistogram histogram={satisfaction.histogram} total={satisfaction.count} />
        </section>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* §18/§29 — the incidents that touched the most people. */}
        <section className="rounded-lg border border-line bg-surface p-5">
          <h2 className="text-sm font-medium">Largest incidents</h2>
          {overview.incidents.length === 0 ? (
            <p className="mt-3 text-sm text-muted">No incidents in this window.</p>
          ) : (
            <ul className="mt-3 space-y-2 text-sm">
              {overview.incidents.map((i) => (
                <li key={i.id} className="flex items-center justify-between gap-3">
                  <Link href={`/incidents/${i.id}`} className="truncate hover:underline">
                    <span className="font-mono text-xs text-muted">{i.code}</span> {i.title}
                  </Link>
                  <span className="flex shrink-0 items-center gap-2">
                    <PriorityBadge priority={i.priority} />
                    <span className="tabular-nums text-muted">{i.affectedCount} affected</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* §29's "frequently reopened" — where a fix did not hold. */}
        <section className="rounded-lg border border-line bg-surface p-5">
          <h2 className="text-sm font-medium">Fixes that did not hold</h2>
          {overview.reopened.length === 0 ? (
            <p className="mt-3 text-sm text-muted">Nothing has been reopened in this window.</p>
          ) : (
            <ul className="mt-3 space-y-2 text-sm">
              {overview.reopened.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-3">
                  <Link href={`/complaints/${c.id}`} className="truncate hover:underline">
                    <span className="font-mono text-xs text-muted">{c.code}</span> {c.title}
                  </Link>
                  <span className="shrink-0 tabular-nums text-muted">
                    reopened {c.reopenCount}×
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
