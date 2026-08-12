import Link from 'next/link';
import { requireRole } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { EscalationBadge, PriorityBadge, SlaBadge, StatusBadge } from '@/components/badges';
import { activeDeadline, queueBucket, slaRisk, sortQueue } from '@/lib/queue/rank';
import { describeMinutes, minutesBetween } from '@/lib/sla/due';
import { isSettled } from '@/lib/lifecycle/machine';
import type { QueueRow } from '@/lib/queue/rank';

/**
 * "due in 3 h" / "overdue by 40 min" for whichever clock is still running — the
 * response one until somebody acknowledges the complaint, the resolution one
 * after. Silent for finished work and for anything with no promise attached.
 */
function deadlineNote(row: QueueRow, now: Date): string | null {
  if (isSettled(row.status)) return null;
  const due = activeDeadline(row);
  if (!due) return null;
  const minutes = minutesBetween(now, due);
  return minutes >= 0 ? `due in ${describeMinutes(minutes)}` : `overdue by ${describeMinutes(minutes)}`;
}

export default async function QueuePage() {
  const session = await requireRole('STAFF', 'DEPT_MANAGER', 'ADMIN');

  // Admins see everything; staff and managers see their own department.
  const where = session.role === 'ADMIN' ? {} : { departmentId: session.departmentId ?? '__none__' };

  const complaints = await prisma.complaint.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: { department: true, location: true, reporter: true, assignee: true, incident: true },
  });

  // §21: Critical → High → SLA approaching → Normal, finished work last. The
  // ordering itself is a pure function so it can be pinned by a unit test.
  const now = new Date();
  const sorted = sortQueue(complaints, now);
  const open = sorted.filter((c) => queueBucket(c, now) !== 'DONE').length;

  return (
    <div>
      <h1 className="text-xl font-semibold">
        {session.role === 'ADMIN' ? 'All complaints' : 'Department queue'}
      </h1>
      <p className="mt-1 text-sm text-muted">
        {open} open of {sorted.length}
      </p>

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
                  {/* Scale is a triage signal (§18): one report and forty look
                      identical in a queue unless the count is on the row. */}
                  {c.incident && c.incident.affectedCount > 1 && (
                    <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-800">
                      {c.incident.code} · {c.incident.affectedCount} affected
                    </span>
                  )}
                  {/* Layer 8 stamps the due dates; these two are what §21's
                      "SLA approaching" bucket looks like on the row itself. */}
                  <SlaBadge risk={slaRisk(c, now)} />
                  <EscalationBadge level={c.escalationLevel} />
                </div>
                <p className="mt-1 font-medium">{c.title}</p>
                <p className="mt-0.5 text-sm text-muted">
                  <span className="font-mono text-xs">score {c.priorityScore}</span> ·{' '}
                  {c.department?.name ?? 'Unrouted'}
                  {c.location ? ` · ${c.location.name}` : ''} ·{' '}
                  {c.isAnonymous ? 'Anonymous' : c.reporter.name} · {c.createdAt.toLocaleString('en-IN')}
                  {c.assignee ? ` · with ${c.assignee.name}` : ''}
                  {/* The deadline in words: staff order their day by "how long
                      have I got", not by a timestamp they have to subtract. */}
                  {deadlineNote(c, now) && ` · ${deadlineNote(c, now)}`}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
