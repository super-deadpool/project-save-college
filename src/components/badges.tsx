import type { ComplaintStatus, Priority } from '@/generated/prisma/enums';

const PRIORITY_STYLE: Record<Priority, string> = {
  CRITICAL: 'bg-red-100 text-red-800',
  HIGH: 'bg-orange-100 text-orange-800',
  MEDIUM: 'bg-amber-100 text-amber-800',
  LOW: 'bg-slate-100 text-slate-700',
};

const STATUS_LABEL: Record<ComplaintStatus, string> = {
  SUBMITTED: 'Submitted',
  ANALYZING: 'Analyzing',
  ASSIGNED: 'Assigned',
  ACKNOWLEDGED: 'Acknowledged',
  IN_PROGRESS: 'In progress',
  WAITING_FOR_STUDENT: 'Waiting for you',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
  REOPENED: 'Reopened',
  REJECTED: 'Rejected',
  DUPLICATE: 'Duplicate',
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
    <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-800">
      {STATUS_LABEL[status]}
    </span>
  );
}
