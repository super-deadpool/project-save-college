import { NextResponse } from 'next/server';
import type { Role } from '@/generated/prisma/enums';
import { getSession } from './session';
import type { SessionPayload } from './jwt';

/**
 * Route Handler guard. Returns either a session or a Response to return as-is:
 *
 *   const guard = await requireApiRole('STAFF');
 *   if (guard instanceof NextResponse) return guard;
 */
export async function requireApiRole(
  ...roles: Role[]
): Promise<SessionPayload | NextResponse> {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }
  if (roles.length > 0 && !roles.includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  return session;
}
