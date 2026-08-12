import Link from 'next/link';
import { departmentDashboard } from '@/lib/analytics/service';
import { count, duration, monthLabel, percent, rating } from '@/lib/analytics/format';
import { BarList, HealthPanel, MonthBars, RatingHistogram, StatTile } from '@/components/charts';
import { EscalationBadge, PriorityBadge, SlaBadge } from '@/components/badges';
import { STATUS_LABEL } from '@/lib/lifecycle/machine';
import type { ComplaintStatus } from '@/generated/prisma/enums';

/**
 * §32's department dashboard. The spec's demand for this screen is one sentence —
 * "staff should immediately know what needs attention right now" — so the
 * attention list is the first thing on it and everything else explains it.
 *
 * The ranking is `sortQueue()` from §21, the risk is `slaRisk()` from Layer 8, and
 * the numbers come from the same service the campus view uses. This page picks
 * nothing itself, which is what stops it disagreeing with the queue.
 */
export async function DepartmentDashboard({ departmentId }: { departmentId: string }) {
  const view = await departmentDashboard(departmentId);
  if (!view) {
    return <p className="text-sm text-muted">This account is not attached to a department.</p>;
  }

  const { totals, satisfaction, openByPriority: bands } = view;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">{view.department.name}</h1>
        <p className="mt-1 text-sm text-muted">
          {monthLabel(view.window.from, 'long')} to today · {count(totals.total)} complaints ·{' '}
          {count(totals.open)} open now
        </p>
      </div>

      {/* §32's own four lines, plus the two that say whether the department is
          keeping its promises. */}
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="rounded-lg border border-line bg-surface p-4">
          <p className="text-xs text-muted">Open by priority</p>
          <dl className="mt-2 space-y-1 text-sm">
            {(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const).map((band) => (
              <div key={band} className="flex items-center justify-between gap-3">
                <dt>
                  <PriorityBadge priority={band} />
                </dt>
                <dd className="tabular-nums">{bands[band]}</dd>
              </div>
            ))}
          </dl>
        </div>
        <StatTile
          label="SLA at risk"
          value={count(view.atRisk)}
          hint={`${count(view.breachedNow)} already past a deadline`}
          tone={view.breachedNow > 0 ? 'critical' : view.atRisk > 0 ? 'warning' : 'good'}
        />
        <StatTile
          label="Escalated to someone above"
          value={count(view.escalated)}
          hint="§22's ladder, currently"
          tone={view.escalated > 0 ? 'warning' : 'good'}
        />
        <StatTile
          label="Avg resolution time"
          value={duration(totals.avgResolutionHours)}
          hint={`response ${totals.avgResponseMinutes == null ? '—' : duration(totals.avgResponseMinutes / 60)}`}
        />
        <StatTile
          label="SLA compliance"
          value={percent(totals.slaCompliance)}
          hint={`${count(totals.breached)} of ${count(totals.withDeadline)} missed`}
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
          hint={`${count(satisfaction.count)} rated · ${count(totals.reopened)} reopened`}
        />
      </section>

      {/* The answer to §32's question, at the top where it belongs. */}
      <section className="rounded-lg border border-line bg-surface p-5">
        <h2 className="text-sm font-medium">What needs attention right now</h2>
        <p className="mt-1 text-xs text-muted">
          §21&apos;s order: critical, then high, then whatever is closest to breaking its promise
        </p>
        {view.attention.length === 0 ? (
          <p className="mt-3 text-sm text-muted">Nothing open. The queue is clear.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line">
            {view.attention.map((row) => (
              <li key={row.id} className="py-2">
                <Link href={`/complaints/${row.id}`} className="block hover:underline">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-muted">{row.code}</span>
                    <PriorityBadge priority={row.priority} />
                    <span className="text-xs text-muted">
                      {STATUS_LABEL[row.status as ComplaintStatus] ?? row.status}
                    </span>
                    <SlaBadge risk={row.risk as 'BREACHED' | 'AT_RISK' | 'OK' | 'NONE'} />
                    <EscalationBadge level={row.escalationLevel} />
                  </div>
                  <p className="mt-0.5 truncate text-sm">{row.title}</p>
                </Link>
              </li>
            ))}
          </ul>
        )}
        <Link href="/queue" className="mt-3 inline-block text-sm text-accent underline">
          Open the full queue
        </Link>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-lg border border-line bg-surface p-5">
          <h2 className="text-sm font-medium">Most common issues</h2>
          <p className="mt-1 text-xs text-muted">
            {view.commonIssue
              ? `Most common: ${view.commonIssue.label} (${view.commonIssue.count})`
              : 'Nothing in this window.'}
          </p>
          <div className="mt-3">
            <BarList
              items={view.categories.map((c) => ({
                key: c.categoryKey,
                label: c.label,
                value: c.count,
                display: count(c.count),
                hint: `${c.open} open · avg ${duration(c.avgResolutionHours)}`,
              }))}
            />
          </div>
        </section>

        <section className="rounded-lg border border-line bg-surface p-5">
          <h2 className="text-sm font-medium">Volume per month</h2>
          <MonthBars months={view.trend} />
        </section>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-lg border border-line bg-surface p-5">
          <h2 className="text-sm font-medium">Department health</h2>
          <div className="mt-2">
            <HealthPanel health={view.health} title={view.department.name} />
          </div>
        </section>

        <section className="rounded-lg border border-line bg-surface p-5">
          <h2 className="text-sm font-medium">What students said</h2>
          <p className="mt-1 text-xs text-muted">
            {satisfaction.count === 0
              ? 'Nothing rated yet.'
              : `${rating(satisfaction.average)} across ${count(satisfaction.count)} ratings`}
          </p>
          <RatingHistogram histogram={satisfaction.histogram} total={satisfaction.count} />

          {view.recurring.length > 0 && (
            <div className="mt-4 border-t border-line pt-3">
              <h3 className="text-xs font-medium">Recurring in this department</h3>
              <ul className="mt-2 space-y-2 text-sm">
                {view.recurring.slice(0, 3).map((signal) => (
                  <li key={`${signal.categoryKey}-${signal.locationId ?? 'campus'}`}>
                    <p>
                      {signal.categoryLabel} · {signal.locationName ?? 'Campus-wide'}{' '}
                      <span className="text-xs text-muted">
                        {signal.growthLabel} · {signal.occurrences} complaints
                      </span>
                    </p>
                    <p className="text-xs text-muted">{signal.suggestion}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
