import { prisma } from '@/lib/db';

/**
 * The demo clock's one operation: make a complaint older.
 *
 * Every clock in this system is the real one — the pure modules take `now` as an
 * argument and the worker runs in its own process — so simulating "three hours
 * later" is done by moving the *complaint* back rather than by moving time
 * forward. The two callers are `/api/dev/advance-clock` and the Layer 8 gate,
 * and they share this so the gate exercises exactly what the demo does.
 *
 * Dev-facing only. Nothing in the request path calls it.
 */
export async function ageComplaints(ids: string[], minutes: number): Promise<void> {
  if (ids.length === 0 || minutes === 0) return;

  await prisma.$executeRaw`
    UPDATE "Complaint"
       SET "createdAt"       = "createdAt"       - make_interval(mins => ${minutes}),
           "responseDueAt"   = "responseDueAt"   - make_interval(mins => ${minutes}),
           "resolutionDueAt" = "resolutionDueAt" - make_interval(mins => ${minutes}),
           "respondedAt"     = "respondedAt"     - make_interval(mins => ${minutes}),
           "resolvedAt"      = "resolvedAt"      - make_interval(mins => ${minutes}),
           "closedAt"        = "closedAt"        - make_interval(mins => ${minutes})
     WHERE "id" = ANY(${ids})
  `;

  // The feed moves with the complaint. Leaving the events behind would show a
  // complaint submitted three hours ago whose first event is dated three hours
  // after that.
  await prisma.$executeRaw`
    UPDATE "ComplaintEvent"
       SET "createdAt" = "createdAt" - make_interval(mins => ${minutes})
     WHERE "complaintId" = ANY(${ids})
  `;
}
