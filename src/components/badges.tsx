import type { ComplaintStatus, Priority } from '@/generated/prisma/enums';
// One label map, in the machine that owns the states.
import { STATUS_LABEL } from '@/lib/lifecycle/machine';

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
