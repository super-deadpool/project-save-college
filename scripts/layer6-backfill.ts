/**
 * One-off: give the complaints that were created before Layer 6 a lifecycle.
 *
 *   npx tsx scripts/layer6-backfill.ts
 *
 * Every row written by Layers 1–5 sits at SUBMITTED, because the automatic
 * ANALYZING → ASSIGNED steps did not exist yet. To a staff member that reads as
 * a complaint nobody can act on: SUBMITTED → ANALYZING is the system's move, so
 * the panel offers them nothing at all.
 *
 * This walks each one through `transition()` — the same path a new complaint
 * takes, with the same events — rather than writing statuses directly. The event
 * timestamps are today's, and honestly so: the analysis was recorded today. The
 * Submitted step still shows the original submission time, which comes from the
 * complaint row rather than from an event.
 *
 * Idempotent: it only ever touches rows still at SUBMITTED.
 */
import 'dotenv/config';
import { prisma } from '@/lib/db';
import { transition } from '@/lib/lifecycle/transition';

async function main() {
  const stranded = await prisma.complaint.findMany({
    where: { status: 'SUBMITTED' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, code: true, department: { select: { name: true } } },
  });

  if (stranded.length === 0) {
    console.log('nothing to backfill — no complaint is still at SUBMITTED');
    await prisma.$disconnect();
    return;
  }

  console.log(`backfilling ${stranded.length} pre-Layer-6 complaint(s)\n`);
  let assigned = 0;
  let triage = 0;

  for (const complaint of stranded) {
    const system = { id: null, role: 'SYSTEM' as const };

    const analyzed = await transition({ complaintId: complaint.id, to: 'ANALYZING', actor: system });
    if (!analyzed.ok) {
      console.log(`  ${complaint.code}: ${analyzed.reason}`);
      continue;
    }

    // No department means routing was never confident enough (§15). Those wait
    // for a human, exactly as a new one would.
    if (!complaint.department) {
      triage++;
      continue;
    }

    const result = await transition({
      complaintId: complaint.id,
      to: 'ASSIGNED',
      actor: system,
      meta: { departmentName: complaint.department.name, backfilled: true },
    });
    if (result.ok) assigned++;
  }

  console.log(`  ${assigned} assigned to a department`);
  console.log(`  ${triage} left at analyzing — no department was routed, so a human picks it up`);

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
