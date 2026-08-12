import type { ComplaintStatus, IncidentStatus } from '@/generated/prisma/enums';
import { isActive, isSettled } from '@/lib/lifecycle/machine';

/**
 * An incident's status is not stored by hand — it is what its members say it is
 * (plan.MD §6's carried note). Pure: statuses in, one status and the sentence
 * behind it out.
 *
 * The asymmetry is deliberate. An incident becomes *active* as soon as **one**
 * member is being worked on, because that is true — someone is on it. It
 * becomes *resolved* only when **every** member is, because forty students are
 * waiting and thirty-nine of them still have a broken Wi-Fi connection.
 */
export interface IncidentStatusRollup {
  status: IncidentStatus;
  reason: string;
}

export function rollupIncidentStatus(memberStatuses: ComplaintStatus[]): IncidentStatusRollup {
  const total = memberStatuses.length;
  if (total === 0) return { status: 'OPEN', reason: 'no complaints in this incident' };

  const closed = memberStatuses.filter(
    (s) => s === 'CLOSED' || s === 'REJECTED' || s === 'DUPLICATE',
  ).length;
  const settled = memberStatuses.filter(isSettled).length;
  const active = memberStatuses.filter(isActive).length;

  if (closed === total) {
    return { status: 'CLOSED', reason: plural(total, 'complaint has', 'complaints have') + ' been closed' };
  }
  if (settled === total) {
    return {
      status: 'RESOLVED',
      reason: `all ${total} ${total === 1 ? 'complaint is' : 'complaints are'} resolved`,
    };
  }
  if (active > 0) {
    return {
      status: 'IN_PROGRESS',
      reason: `${active} of ${total} ${total === 1 ? 'complaint is' : 'complaints are'} being worked on`,
    };
  }
  return {
    status: 'OPEN',
    reason: `${total - settled} of ${total} ${total === 1 ? 'complaint is' : 'complaints are'} waiting to be picked up`,
  };
}

const plural = (n: number, one: string, many: string) => `${n === 1 ? 'the' : `all ${n}`} ${n === 1 ? one : many}`;
