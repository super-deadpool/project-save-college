import { NextResponse } from 'next/server';
import { requireApiRole } from '@/lib/auth/api';
import { scanSla } from '@/lib/sla/service';

/**
 * §22's sweep, on demand — the same call `npm run worker` makes every minute.
 * It exists so a walkthrough does not have to wait for the cron tick, and so the
 * gate can assert the ladder over the API rather than only through the service.
 *
 * Safe to call repeatedly: `scanSla()` only ever moves a complaint up a rung it
 * has not already been recorded on.
 */
export async function POST() {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'Not available' }, { status: 404 });
  }

  const session = await requireApiRole('DEPT_MANAGER', 'ADMIN');
  if (session instanceof NextResponse) return session;

  const result = await scanSla();

  return NextResponse.json({
    scanned: result.scanned,
    breaching: result.breaching,
    escalated: result.escalated.map((e) => ({
      code: e.code,
      from: e.from,
      to: e.to,
      steps: e.steps.map((s) => ({ level: s.level, kind: s.kind, notify: s.notify, flagged: s.flagged })),
    })),
  });
}
