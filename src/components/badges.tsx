import type { ComplaintStatus, Priority } from '@/generated/prisma/enums';
// One label map, in the machine that owns the states.
import { STATUS_LABEL } from '@/lib/lifecycle/machine';
import type { SlaRisk } from '@/lib/queue/rank';

const PRIORITY_STYLE: Record<Priority, string> = {
  CRITICAL: 'bg-red-100 text-red-800',
  HIGH: 'bg-orange-100 text-orange-800',
  MEDIUM: 'bg-amber-100 text-amber-800',
  LOW: 'bg-slate-100 text-slate-700',
};

const STATUS_STYLE: Partial<Record<ComplaintStatus, string>> = {
  RESOLVED: 'bg-green-50 text-green-800',
  CLOSED: 'bg-slate-100 text-slate-700',
  REJECTED: 'bg-slate-100 text-slate-700',
  DUPLICATE: 'bg-slate-100 text-slate-700',
  WAITING_FOR_STUDENT: 'bg-yellow-50 text-yellow-800',
  REOPENED: 'bg-orange-50 text-orange-800',
};

export function PriorityBadge({ priority }: { priority: Priority }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${PRIORITY_STYLE[priority]}`}>
      {priority}
    </span>
  );
}

/**
 * §22's promise, on the row: breached in red, approaching in orange, nothing at
 * all when the complaint is inside its window or has no window to be inside.
 * Silence is the common case, so it must not take up space.
 */
export function SlaBadge({ risk }: { risk: SlaRisk }) {
  if (risk === 'BREACHED') {
    return (
      <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">
        SLA breached
      </span>
    );
  }
  if (risk === 'AT_RISK') {
    return (
      <span className="rounded-full bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-800">
        SLA approaching
      </span>
    );
  }
  return null;
}

/**
 * Which rung of §22 a complaint has reached. Level 3 is the flagged one — twice
 * the resolution window gone — and `escalationLevel >= 3` *is* the flag, so it
 * says so rather than making a reader count rungs.
 */
export function EscalationBadge({ level }: { level: number }) {
  if (level <= 0) return null;
  const flagged = level >= 3;
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
        flagged ? 'bg-red-800 text-white' : 'bg-purple-100 text-purple-900'
      }`}
    >
      {flagged ? 'Flagged · escalated to admin' : level === 2 ? 'Escalated to admin' : 'Escalated to manager'}
    </span>
  );
}

export function StatusBadge({ status }: { status: ComplaintStatus }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
        STATUS_STYLE[status] ?? 'bg-blue-50 text-blue-800'
      }`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}
