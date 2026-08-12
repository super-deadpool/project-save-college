import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { Role } from '@/generated/prisma/enums';
import { signSession, verifySession, type SessionPayload } from './jwt';

export const SESSION_COOKIE = 'scms_session';

export async function createSessionCookie(payload: SessionPayload) {
  const token = await signSession(payload);
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
  });
}

export async function clearSessionCookie() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

/** Current session, or null. Never throws. */
export async function getSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySession(token);
}

/** For pages: redirects to /login when signed out. */
export async function requireSession(): Promise<SessionPayload> {
  const session = await getSession();
  if (!session) redirect('/login');
  return session;
}

/** For pages: redirects to the caller's own home when the role is wrong. */
export async function requireRole(...roles: Role[]): Promise<SessionPayload> {
  const session = await requireSession();
  if (!roles.includes(session.role)) redirect(homeFor(session.role));
  return session;
}

/** Where each role lands after login. */
export function homeFor(role: Role): string {
  switch (role) {
    case 'STUDENT':
      return '/report';
    case 'STAFF':
      return '/queue';
    case 'DEPT_MANAGER':
    case 'ADMIN':
      return '/dashboard';
  }
}
