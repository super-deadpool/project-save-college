import Link from 'next/link';
import { requireRole } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { PriorityBadge, StatusBadge } from '@/components/badges';

export default async function ComplaintsPage() {
  const session = await requireRole('STUDENT');

  const complaints = await prisma.complaint.findMany({
    where: { reporterId: session.sub },
    orderBy: { createdAt: 'desc' },
    include: { department: true, location: true },
  });

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">My complaints</h1>
        <Link href="/report" className="text-sm text-accent underline">
          Report an issue
        </Link>
      </div>

      {complaints.length === 0 ? (
        <p className="mt-6 text-sm text-muted">Nothing reported yet.</p>
      ) : (
        <ul className="mt-6 divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
          {complaints.map((c) => (
            <li key={c.id}>
              <Link href={`/complaints/${c.id}`} className="block p-4 hover:bg-background">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-muted">{c.code}</span>
                  <StatusBadge status={c.status} />
                  <PriorityBadge priority={c.priority} />
                </div>
                <p className="mt-1 font-medium">{c.title}</p>
                <p className="mt-0.5 text-sm text-muted">
                  {c.department?.name ?? 'Awaiting triage'}
                  {c.location ? ` · ${c.location.name}` : ''} ·{' '}
                  {c.createdAt.toLocaleString('en-IN')}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
