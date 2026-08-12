import type { ComplaintStatus, Priority } from '@/generated/prisma/enums';
import { isSettled } from '@/lib/lifecycle/machine';

/**
 * §21's ordering. Staff should not see "100 random complaints" — they should see
 *
 *     Critical → High → SLA approaching → Normal
 *
 * Pure: rows and a clock in, a sorted array out. That keeps the ordering a unit
 * test rather than something only visible by squinting at a page.
 *
 * The SLA due dates are Layer 8's to fill in; they are nullable here on purpose.
 * Until then `AT_RISK` simply never fires and the order degrades to band → score
 * → age, which is the same order as before. When Layer 8 starts stamping
 * `responseDueAt` / `resolutionDueAt`, this bucket lights up with no change here.
 */

export type QueueBucket = 'CRITICAL' | 'HIGH' | 'AT_RISK' | 'NORMAL' | 'DONE';

/** How close a complaint is to breaking its promise. */
export type SlaRisk = 'BREACHED' | 'AT_RISK' | 'OK' | 'NONE';

export interface QueueRow {
  priority: Priority;
  priorityScore: number;
  status: ComplaintStatus;
  createdAt: Date;
  responseDueAt: Date | null;
  resolutionDueAt: Date | null;
  respondedAt: Date | null;
}

/** The last quarter of a window is "approaching" — enough time left to act. */
export const AT_RISK_FRACTION = 0.25;

const BUCKET_ORDER: Record<QueueBucket, number> = {
  CRITICAL: 0,
  HIGH: 1,
  AT_RISK: 2,
  NORMAL: 3,
  DONE: 4,
};

const PRIORITY_ORDER: Record<Priority, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

/**
 * The relevant deadline is whichever one is still live: the response clock until
 * someone acknowledges the complaint, the resolution clock afterwards.
 */
export function activeDeadline(row: QueueRow): Date | null {
  if (!row.respondedAt && row.responseDueAt) return row.responseDueAt;
  return row.resolutionDueAt;
}

export function slaRisk(row: QueueRow, now: Date): SlaRisk {
  if (isSettled(row.status)) return 'NONE';
  const due = activeDeadline(row);
  if (!due) return 'NONE';

  if (now.getTime() >= due.getTime()) return 'BREACHED';

  const window = due.getTime() - row.createdAt.getTime();
  if (window <= 0) return 'BREACHED';
  const remaining = due.getTime() - now.getTime();
  return remaining / window <= AT_RISK_FRACTION ? 'AT_RISK' : 'OK';
}

export function queueBucket(row: QueueRow, now: Date): QueueBucket {
  // Finished work sinks. §21 lists four bands of things needing attention, and
  // a resolved complaint is not one of them — but it stays in the list, because
  // staff still need to find what they closed this morning.
  if (isSettled(row.status)) return 'DONE';
  if (row.priority === 'CRITICAL') return 'CRITICAL';
  if (row.priority === 'HIGH') return 'HIGH';

  const risk = slaRisk(row, now);
  if (risk === 'BREACHED' || risk === 'AT_RISK') return 'AT_RISK';
  return 'NORMAL';
}

/**
 * Sort in place-safe fashion: bucket, then a breach ahead of a mere risk, then
 * the rubric's own band and score, then oldest first so nothing starves at the
 * bottom of a busy queue.
 */
export function sortQueue<T extends QueueRow>(rows: T[], now: Date): T[] {
  const keyed = rows.map((row) => ({
    row,
    bucket: BUCKET_ORDER[queueBucket(row, now)],
    breached: slaRisk(row, now) === 'BREACHED' ? 0 : 1,
  }));

  keyed.sort(
    (a, b) =>
      a.bucket - b.bucket ||
      a.breached - b.breached ||
      PRIORITY_ORDER[a.row.priority] - PRIORITY_ORDER[b.row.priority] ||
      b.row.priorityScore - a.row.priorityScore ||
      a.row.createdAt.getTime() - b.row.createdAt.getTime(),
  );

  return keyed.map((k) => k.row);
}
