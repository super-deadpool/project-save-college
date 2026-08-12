import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/auth/session';
import { PriorityBadge, StatusBadge } from '@/components/badges';
import { INCIDENT_STATUS_LABEL } from '@/lib/incidents/message';
import { canViewIncident, loadIncident, reporterLabel } from '@/lib/incidents/view';
import { nextStatuses } from '@/lib/lifecycle/machine';
import { IncidentActions } from './incident-actions';
import type { ComplaintStatus } from '@/generated/prisma/enums';

/**
 * The §17 incident view: one issue, its scale, and the complaints inside it.
 * Students reach it from their own complaint and see the scale without the
 * roster; staff see every member with the dedup score that put it there.
 */
export default async function IncidentPage({ params }: PageProps<'/incidents/[id]'>) {
  const session = await requireSession();
  const { id } = await params;

  const view = await loadIncident(id);
  if (!view) notFound();
  if (!canViewIncident(view, session)) notFound();

  const isStudent = session.role === 'STUDENT';
  const { incident, message } = view;
  const members = incident.complaints.filter((c) => !isStudent || c.reporterId === session.sub);

  // Every move that is legal for at least one member. A member that cannot make
  // it is skipped by the API and reported back, rather than blocking the rest.
  const actions = isStudent ? [] : dedupeActions(incident.complaints.map((c) => c.status), session.role);

  return (
    <div className="space-y-6">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-muted">{incident.code}</span>
          <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-800">
            {INCIDENT_STATUS_LABEL[incident.status]}
          </span>
          <PriorityBadge priority={incident.priority} />
        </div>
        <h1 className="mt-2 text-xl font-semibold">{incident.title}</h1>
        <p className="mt-1 text-sm text-muted">
          {view.departmentName ??
            (isStudent ? 'To be assigned by the campus office' : 'Unrouted — needs triage')}
          {incident.location ? ` · ${incident.location.name}` : ''} ·{' '}
          {incident.createdAt.toLocaleString('en-IN')}
        </p>
      </div>

      {/* §18 — the affected count is the headline fact, not a footnote. */}
      <section className="rounded-lg border border-line bg-surface p-5">
        <p className="text-2xl font-semibold">
          {incident.affectedCount}{' '}
          <span className="text-base font-normal text-muted">
            {incident.affectedCount === 1 ? 'student has' : 'students have'} reported this issue
          </span>
        </p>
        {!isStudent && (
          <p className="mt-2 text-sm text-muted">
            Incident priority: {incident.priority.toLowerCase()} — {view.rollup.reason}
          </p>
        )}
        {isStudent && message && <p className="mt-2 text-sm text-muted">{message.body}</p>}
      </section>

      {!isStudent && (
        <IncidentActions
          incidentId={incident.id}
          memberCount={incident.complaints.length}
          actions={actions}
        />
      )}

      <section className="rounded-lg border border-line bg-surface p-5">
        <h2 className="text-sm font-medium">
          {isStudent ? 'Your complaint in this incident' : `Linked complaints (${members.length})`}
        </h2>
        <ul className="mt-3 divide-y divide-line">
          {members.map((c) => (
            <li key={c.id}>
              <Link href={`/complaints/${c.id}`} className="block py-3 hover:opacity-80">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-muted">{c.code}</span>
                  <StatusBadge status={c.status} />
                  <PriorityBadge priority={c.priority} />
                  {c.reporterId === session.sub && (
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
                      Yours
                    </span>
                  )}
                </div>
                <p className="mt-1 text-sm font-medium">{c.title}</p>
                <p className="mt-0.5 text-xs text-muted">
                  {!isStudent && `${reporterLabel(c, session.role)} · `}
                  {c.createdAt.toLocaleString('en-IN')}
                  {/* Why this complaint is in this incident — a dedup verdict is
                      explainable for the same reason a priority band is (§14). */}
                  {!isStudent && c.dedupVerdict !== 'NEW' && (
                    <span className="font-mono">
                      {' '}
                      · {c.dedupVerdict.toLowerCase().replace('_', ' ')} at{' '}
                      {c.dedupScore.toFixed(2)}
                    </span>
                  )}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {isStudent && message && (
        <p className="text-sm text-muted">{message.reassurance}</p>
      )}
    </div>
  );
}

/**
 * The union of what the members allow, labelled for a bulk action. Union rather
 * than intersection because an incident whose members are at different stages
 * should still be resolvable in one click once the fix is in.
 */
function dedupeActions(statuses: ComplaintStatus[], role: 'STAFF' | 'DEPT_MANAGER' | 'ADMIN' | 'STUDENT') {
  const byStatus = new Map<ComplaintStatus, { status: ComplaintStatus; label: string; requiresNote: boolean }>();
  for (const status of statuses) {
    for (const rule of nextStatuses(status, role)) {
      if (!byStatus.has(rule.to)) {
        byStatus.set(rule.to, {
          status: rule.to,
          label: `${rule.label} all`,
          requiresNote: Boolean(rule.requiresNote),
        });
      }
    }
  }
  return [...byStatus.values()];
}
