import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { SESSION_COOKIE } from '@/lib/auth/session';

/**
 * Next 16 renamed Middleware to Proxy. This is only an *optimistic* check —
 * it bounces requests with no session cookie straight to /login so pages don't
 * render first. Real authorization lives in the layouts and route handlers
 * (`requireRole` / `requireApiRole`), which verify the JWT and the role.
 */
export function proxy(request: NextRequest) {
  const hasCookie = Boolean(request.cookies.get(SESSION_COOKIE)?.value);
  if (hasCookie) return NextResponse.next();

  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/report/:path*', '/complaints/:path*', '/queue/:path*', '/dashboard/:path*', '/incidents/:path*'],
};
