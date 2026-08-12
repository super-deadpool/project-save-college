import 'dotenv/config';
import { schedule } from 'node-cron';
import { prisma } from '@/lib/db';
import { scanSla } from '@/lib/sla/service';
import { scanRecurring } from '@/lib/analytics/service';

/**
 * The background half of the system (plan.MD §7, Layers 8 and 10).
 *
 *   npm run worker            # every minute, forever
 *   npm run worker -- --once  # one sweep of each job and exit — what the gates use
 *
 * Two jobs, and the worker holds no rules of its own: §22's escalation sweep every
 * minute, and §30's recurring-trend scan nightly. Both are idempotent — a
 * complaint only ever moves *up* the ladder, and a trend for a given month
 * refreshes its row rather than adding one — so a missed tick costs nothing, two
 * workers cannot double-report, and the same work can be triggered by hand from
 * `/api/dev/sla-scan` or the dashboard's scan button during a demo.
 */

const EVERY_MINUTE = '* * * * *';
/** 02:15 — after midnight, so "this month" means the month that just ended. */
const NIGHTLY = '15 2 * * *';

async function sweep(): Promise<void> {
  const started = Date.now();
  try {
    const result = await scanSla();
    const took = Date.now() - started;

    // Quiet by default: a line a minute saying "nothing was late" is a line
    // nobody reads, and it buries the ones that matter.
    if (result.escalated.length > 0) {
      for (const item of result.escalated) {
        const rungs = item.steps.map((s) => `${s.level}:${s.kind}→${s.notify}`).join(', ');
        console.log(`[sla] ${item.code} escalated ${item.from} → ${item.to} (${rungs})`);
      }
    }
    if (result.breaching > 0 || result.escalated.length > 0) {
      console.log(
        `[sla] ${result.scanned} with a live promise · ${result.breaching} past a deadline · ` +
          `${result.escalated.length} escalated · ${took}ms`,
      );
    }
  } catch (error) {
    // A failed sweep must not take the worker down: the next minute is a retry.
    console.error('[sla] sweep failed', error);
  }
}

/** §30's nightly trend scan — the recommendations, written down. */
async function recurringSweep(): Promise<void> {
  try {
    const result = await scanRecurring();
    if (result.detected > 0) {
      console.log(
        `[recurring] ${result.detected} trend(s) · ${result.written} new · ${result.refreshed} refreshed`,
      );
      for (const signal of result.signals) {
        console.log(`[recurring] ${signal.severity}: ${signal.narrative}`);
      }
    }
  } catch (error) {
    console.error('[recurring] scan failed', error);
  }
}

async function main() {
  const once = process.argv.includes('--once');

  if (once) {
    await sweep();
    await recurringSweep();
    await prisma.$disconnect();
    return;
  }

  console.log('worker up · SLA sweep every minute (§22) · recurring scan nightly (§30). Ctrl-C to stop.');
  await sweep();
  const tasks = [schedule(EVERY_MINUTE, sweep), schedule(NIGHTLY, recurringSweep)];

  const stop = async () => {
    console.log('\nworker stopping');
    await Promise.all(tasks.map((task) => task.stop()));
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
