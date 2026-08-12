import { NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/api';
import { scanRecurring, storedRecurringSignals } from '@/lib/analytics/service';

/**
 * §30 — detect the rising trends and write them down.
 *
 * Idempotent per (category, building, window end): rescanning the same month
 * refreshes that row rather than stacking another, so the nightly worker sweep and
 * an administrator pressing the button five minutes apart cannot produce five
 * copies of the same recommendation.
 */
export async function POST() {
  const session = await requireApiRole('ADMIN');
  if (session instanceof NextResponse) return session;

  const result = await scanRecurring();

  return NextResponse.json({
    detected: result.detected,
    written: result.written,
    refreshed: result.refreshed,
    signals: result.signals.map((s) => ({
      categoryKey: s.categoryKey,
      locationName: s.locationName,
      occurrences: s.occurrences,
      growthRate: s.growthRate,
      severity: s.severity,
      narrative: s.narrative,
      suggestion: s.suggestion,
      windowStart: s.windowStart,
      windowEnd: s.windowEnd,
    })),
  });
}

/** What has been recorded so far — §30's alerts as a list somebody can review. */
export async function GET() {
  const session = await requireApiRole('DEPT_MANAGER', 'ADMIN');
  if (session instanceof NextResponse) return session;

  return NextResponse.json({ signals: await storedRecurringSignals(25) });
}
