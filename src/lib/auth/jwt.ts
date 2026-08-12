import { SignJWT, jwtVerify } from 'jose';
import type { Role } from '@/generated/prisma/enums';

export type SessionPayload = {
  sub: string;
  email: string;
  name: string;
  role: Role;
  departmentId: string | null;
};

const SESSION_TTL = '7d';

function secret(): Uint8Array {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error('AUTH_SECRET is not set');
  return new TextEncoder().encode(s);
}

export async function signSession(payload: SessionPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(SESSION_TTL)
    .sign(secret());
}

export async function verifySession(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secret());
    return {
      sub: String(payload.sub),
      email: String(payload.email),
      name: String(payload.name),
      role: payload.role as Role,
      departmentId: (payload.departmentId as string | null) ?? null,
    };
  } catch {
    return null;
  }
}
