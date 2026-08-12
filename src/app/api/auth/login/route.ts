import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { verifyPassword } from '@/lib/auth/password';
import { createSessionCookie, homeFor } from '@/lib/auth/session';

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function POST(request: Request) {
  const parsed = LoginBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Email and password are required' }, { status: 400 });
  }

  const { email, password } = parsed.data;
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
  // Same message either way — do not leak which emails exist.
  const ok = user && user.isActive && (await verifyPassword(password, user.passwordHash));
  if (!user || !ok) {
    return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 });
  }

  await createSessionCookie({
    sub: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    departmentId: user.departmentId,
  });

  return NextResponse.json({
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
    redirectTo: homeFor(user.role),
  });
}
