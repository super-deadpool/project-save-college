import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { PriorityBadge, StatusBadge } from '@/components/badges';
import { getCategory } from '@/lib/engine/schemas';
import { summaryLines } from '@/lib/engine/summary';
import { incidentMessage, isSharedIncident } from '@/lib/incidents/message';
import { Stepper } from '@/components/stepper';
import { nextStatuses } from '@/lib/lifecycle/machine';
import { stepperFor } from '@/lib/lifecycle/stepper';
import { statusStamps, timelineEntry, visibleTo } from '@/lib/lifecycle/timeline';
import { MergeSuggestion } from './merge-suggestion';
import { StaffActions, StudentReply } from './lifecycle-actions';
import type { PriorityReason } from '@/lib/engine/priority';
import type { SlotValues } from '@/lib/engine/types';

export default async function ComplaintDetailPage({ params }: PageProps<'/complaints/[id]'>) {
  const session = await requireSession();
  const { id } = await params;

  const complaint = await prisma.complaint.findUnique({
    where: { id },
    include: {
      department: true,
      location: true,
      reporter: true,
      assignee: true,
      incident: true,
      // cuid v1 sorts by creation time, which keeps two events written in the
      // same millisecond — submission writes three — in the order they happened.
      events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], include: { actor: true } },
    },
  });
  if (!complaint) notFound();

  // Students only ever see their own complaints; staff see their department's.
  const mayView =
    session.role === 'ADMIN' ||
    complaint.reporterId === session.sub ||
    (session.departmentId != null && complaint.departmentId === session.departmentId);
  if (!mayView) notFound();

  const schema = getCategory(complaint.categoryKey);
  const lines = schema
    ? summaryLines(schema, complaint.slots as unknown as SlotValues, complaint.location?.name)
    : [];

  const isStudentView = session.role === 'STUDENT';

  // §36 — a shared issue gets the incident message instead of a generic ack. A
  // size-1 incident stays invisible: it is just this complaint (plan.MD §6).
  const incident = complaint.incident;
  const shared = incident != null && isSharedIncident(incident.affectedCount);
  const banner = shared
    ? incidentMessage({
        code: incident.code,
        title: incident.title,
        status: incident.status,
        priority: incident.priority,
        affectedCount: incident.affectedCount,
        departmentName: complaint.department?.name ?? null,
      })
    : null;

  // The 0.45–0.70 near-miss, staff-only. The latest suggestion wins; an older one
  // that has since been ruled on is superseded by the complaint's own incident.
  const suggestionEvent = [...complaint.events]
    .reverse()
    .find((e) => e.type === 'DUPLICATE_SUGGESTED');
  const suggestionMeta = (suggestionEvent?.meta ?? {}) as {
    suggestedIncidentId?: string;
    suggestedIncidentCode?: string;
    dedupScore?: number;
  };
  const showSuggestion =
    !isStudentView &&
    suggestionMeta.suggestedIncidentId != null &&
    suggestionMeta.suggestedIncidentId !== complaint.incidentId;

  // §20 — the lifecycle, told twice: the stepper for "where is it", the feed for
  // "what happened". Both read the same STATUS_CHANGED events, so they cannot
  // disagree with each other or with the status badge above.
  const entries = complaint.events.map((e) =>
    timelineEntry({
      id: e.id,
      type: e.type,
      message: e.message,
      meta: e.meta,
      isInternal: e.isInternal,
      createdAt: e.createdAt,
      actorName: e.actor?.name ?? null,
    }),
  );
  const steps = stepperFor({
    status: complaint.status,
    stamps: statusStamps(
      complaint.events.map((e) => ({
        id: e.id,
        type: e.type,
        message: e.message,
        meta: e.meta,
        isInternal: e.isInternal,
        createdAt: e.createdAt,
        actorName: null,
      })),
    ),
    departmentName: complaint.department?.name ?? null,
    submittedAt: complaint.createdAt,
  });

  // The buttons a staff member gets are whatever the transition table allows
  // them from here. Two are pulled out because they are more than a status
  // change: accepting also claims ownership, and asking for information needs
  // the question itself.
  const staffActions = !isStudentView
    ? nextStatuses(complaint.status, session.role)
        .filter((r) => r.to !== 'ACKNOWLEDGED' && r.to !== 'WAITING_FOR_STUDENT')
        .map((r) => ({ status: r.to, label: r.label, requiresNote: Boolean(r.requiresNote) }))
    : [];
  const canAccept = !isStudentView && nextStatuses(complaint.status, session.role).some((r) => r.to === 'ACKNOWLEDGED');
  const canRequestInfo =
    !isStudentView && nextStatuses(complaint.status, session.role).some((r) => r.to === 'WAITING_FOR_STUDENT');

  // What the student is being asked, so the reply box repeats the question.
  const pendingQuestion =
    complaint.status === 'WAITING_FOR_STUDENT'
      ? ([...complaint.events].reverse().find((e) => e.type === 'INFO_REQUESTED')?.message ?? null)
      : null;

  const reasons = complaint.priorityReasons as unknown as PriorityReason[];
  // §14 — the band is never shown without its reasons. Students get the
  // sentences; staff also get the points behind each one.
  const shownReasons = isStudentView
    ? reasons.filter((r) => r.code !== 'CATEGORY' && (r.code === 'OVERRIDE' || r.points > 0)).slice(0, 4)
    : reasons;

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-muted">{complaint.code}</span>
          <StatusBadge status={complaint.status} />
          <PriorityBadge priority={complaint.priority} />
          {complaint.needsTriage && (
            <span className="rounded-full bg-yellow-100 px-2 py-0.5 text-xs text-yellow-800">
              Needs triage
            </span>
          )}
        </div>
        <h1 className="mt-2 text-xl font-semibold">{complaint.title}</h1>
        <p className="mt-1 text-sm text-muted">
          {complaint.department?.name ??
            (isStudentView ? 'To be assigned by the campus office' : 'Unrouted — needs triage')}
          {complaint.location ? ` · ${complaint.location.name}` : ''} ·{' '}
          {complaint.createdAt.toLocaleString('en-IN')}
          {complaint.assignee && ` · with ${complaint.assignee.name}`}
        </p>
      </div>

      {/* §20 — the student's first question is "where has my complaint got to",
          so the tracker comes before every explanation of it. */}
      <section className="rounded-lg border border-line bg-surface p-5">
        <h2 className="text-sm font-medium">Progress</h2>
        <div className="mt-4">
          <Stepper steps={steps} />
        </div>
      </section>

      {complaint.status === 'WAITING_FOR_STUDENT' && complaint.reporterId === session.sub && (
        <StudentReply complaintId={complaint.id} question={pendingQuestion} />
      )}

      {!isStudentView && (
        <StaffActions
          complaintId={complaint.id}
          canAccept={canAccept}
          canRequestInfo={canRequestInfo}
          actions={staffActions}
        />
      )}

      {banner && incident && (
        <section className="rounded-lg border border-blue-200 bg-blue-50 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-blue-900">{incident.code}</span>
            <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-900">
              {banner.statusLabel}
            </span>
          </div>
          <h2 className="mt-2 text-sm font-semibold text-blue-950">{banner.heading}</h2>
          <p className="mt-1 text-sm text-blue-900">{banner.body}</p>
          <p className="mt-2 text-sm font-medium text-blue-950">{banner.affectedLine}</p>
          {isStudentView && <p className="mt-1 text-sm text-blue-900">{banner.reassurance}</p>}
          <Link
            href={`/incidents/${incident.id}`}
            className="mt-3 inline-block text-sm text-blue-900 underline"
          >
            View the incident
          </Link>
        </section>
      )}

      {showSuggestion && suggestionMeta.suggestedIncidentId && (
        <MergeSuggestion
          complaintId={complaint.id}
          incidentId={suggestionMeta.suggestedIncidentId}
          incidentCode={suggestionMeta.suggestedIncidentCode ?? 'the open incident'}
          score={suggestionMeta.dedupScore ?? null}
          explain={suggestionEvent?.message ?? null}
        />
      )}

      {shownReasons.length > 0 && (
        <section className="rounded-lg border border-line bg-surface p-5">
          <h2 className="text-sm font-medium">
            Why this is {complaint.priority.toLowerCase()} priority
          </h2>
          <ul className="mt-3 space-y-2 text-sm">
            {shownReasons.map((reason, i) => (
              <li key={`${reason.code}-${i}`} className="flex items-start justify-between gap-4">
                <span>
                  {reason.label}
                  {!isStudentView && reason.detail && (
                    <span className="block text-xs text-muted">{reason.detail}</span>
                  )}
                </span>
                {!isStudentView && reason.points > 0 && (
                  <span className="shrink-0 font-mono text-xs text-muted">+{reason.points}</span>
                )}
              </li>
            ))}
          </ul>
          {!isStudentView && (
            <p className="mt-3 border-t border-line pt-3 font-mono text-xs text-muted">
              score {complaint.priorityScore} · routing confidence{' '}
              {complaint.routingScore.toFixed(2)} · signature {complaint.signature ?? '—'}
            </p>
          )}
        </section>
      )}

      {lines.length > 0 && (
        <section className="rounded-lg border border-line bg-surface p-5">
          <h2 className="text-sm font-medium">What we understood</h2>
          <dl className="mt-3 grid gap-2 sm:grid-cols-2">
            {lines.map((l) => (
              <div key={l.slotKey} className="text-sm">
                <dt className="text-muted">{l.label}</dt>
                <dd>{l.display}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <section className="rounded-lg border border-line bg-surface p-5">
        <h2 className="text-sm font-medium">Updates</h2>
        <ol className="mt-3 space-y-3">
          {entries
            .filter((entry) => visibleTo(entry, session.role))
            .map((entry) => (
              <li key={entry.id} className="grid gap-1 sm:grid-cols-[10rem_1fr]">
                <span className="text-xs text-muted">{entry.at.toLocaleString('en-IN')}</span>
                <div className="text-sm">
                  <p className="font-medium">
                    {entry.headline}
                    {entry.isInternal && (
                      <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-normal text-slate-600">
                        internal
                      </span>
                    )}
                  </p>
                  {entry.detail && <p className="text-muted">{entry.detail}</p>}
                </div>
              </li>
            ))}
        </ol>
      </section>
    </div>
  );
}
