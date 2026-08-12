import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { PriorityBadge, StatusBadge } from '@/components/badges';
import { getCategory } from '@/lib/engine/schemas';
import { summaryLines } from '@/lib/engine/summary';
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
      events: { orderBy: { createdAt: 'asc' }, include: { actor: true } },
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
        </p>
      </div>

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
        <h2 className="text-sm font-medium">Timeline</h2>
        <ol className="mt-3 space-y-3">
          {complaint.events
            .filter((e) => !e.isInternal || session.role !== 'STUDENT')
            .map((e) => (
              <li key={e.id} className="text-sm">
                <span className="text-muted">{e.createdAt.toLocaleString('en-IN')}</span>{' '}
                <span className="font-medium">{e.type.replace(/_/g, ' ').toLowerCase()}</span>
                {e.message && <p className="text-muted">{e.message}</p>}
              </li>
            ))}
        </ol>
      </section>
    </div>
  );
}
