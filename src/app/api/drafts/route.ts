import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireApiRole } from '@/lib/auth/api';
import { createDraft } from '@/lib/drafts/service';

const StartBody = z.object({ rawText: z.string().min(1).max(2000) });

export async function POST(request: Request) {
  const session = await requireApiRole('STUDENT');
  if (session instanceof NextResponse) return session;

  const parsed = StartBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Describe the problem in a sentence' }, { status: 400 });
  }

  const view = await createDraft(session.sub, parsed.data.rawText.trim());
  return NextResponse.json({ draft: view }, { status: 201 });
}
