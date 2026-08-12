import Link from 'next/link';
import { requireRole } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { PriorityBadge, StatusBadge } from '@/components/badges';

const PRIORITY_ORDER = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 } as const;

export default async function QueuePage() {
  const session = await requireRole('STAFF', 'DEPT_MANAGER', 'ADMIN');

  // Admins see everything; staff and managers see their own department.
  const where = session.role === 'ADMIN' ? {} : { departmentId: session.departmentId ?? '__none__' };

  const complaints = await prisma.complaint.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: { department: true, location: true, reporter: true },
  });

  // Band first, then the rubric score inside a band, then oldest-first so nothing
  // starves. §21's full SLA-aware ordering lands with the lifecycle work.
  const sorted = [...complaints].sort(
    (a, b) =>
      PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
      b.priorityScore - a.priorityScore ||
      a.createdAt.getTime() - b.createdAt.getTime(),
  );

  return (
    <div>
      <h1 className="text-xl font-semibold">
        {session.role === 'ADMIN' ? 'All complaints' : 'Department queue'}
      </h1>
      <p className="mt-1 text-sm text-muted">{sorted.length} complaint(s)</p>

      {sorted.length === 0 ? (
        <p className="mt-6 text-sm text-muted">Nothing in the queue.</p>
      ) : (
        <ul className="mt-6 divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
          {sorted.map((c) => (
            <li key={c.id}>
              <Link href={`/complaints/${c.id}`} className="block p-4 hover:bg-background">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-muted">{c.code}</span>
                  <PriorityBadge priority={c.priority} />
                  <StatusBadge status={c.status} />
                  {c.needsTriage && (
                    <span className="rounded-full bg-yellow-100 px-2 py-0.5 text-xs text-yellow-800">
                      Needs triage
                    </span>
                  )}
                </div>
                <p className="mt-1 font-medium">{c.title}</p>
                <p className="mt-0.5 text-sm text-muted">
                  <span className="font-mono text-xs">score {c.priorityScore}</span> ·{' '}
                  {c.department?.name ?? 'Unrouted'}
                  {c.location ? ` · ${c.location.name}` : ''} ·{' '}
                  {c.isAnonymous ? 'Anonymous' : c.reporter.name} · {c.createdAt.toLocaleString('en-IN')}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
