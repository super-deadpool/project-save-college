import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireApiRole } from '@/lib/auth/api';
import {
  addMessage,
  answerSlot,
  buildView,
  editSlot,
  loadDraft,
  setCategory,
} from '@/lib/drafts/service';

const ActionBody = z.discriminatedUnion('action', [
  z.object({ action: z.literal('category'), categoryKey: z.string() }),
  z.object({
    action: z.literal('answer'),
    slotKey: z.string(),
    kind: z.enum(['VALUE', 'UNSURE', 'SKIP']),
    value: z.unknown().optional(),
  }),
  z.object({ action: z.literal('message'), text: z.string().min(1).max(2000), slotKey: z.string().optional() }),
  z.object({ action: z.literal('edit'), slotKey: z.string() }),
]);

export async function GET(_request: Request, { params }: RouteContext<'/api/drafts/[id]'>) {
  const session = await requireApiRole('STUDENT');
  if (session instanceof NextResponse) return session;

  const { id } = await params;
  const row = await loadDraft(id, session.sub);
  if (!row) return NextResponse.json({ error: 'Draft not found' }, { status: 404 });

  return NextResponse.json({ draft: await buildView(row) });
}

export async function POST(request: Request, { params }: RouteContext<'/api/drafts/[id]'>) {
  const session = await requireApiRole('STUDENT');
  if (session instanceof NextResponse) return session;

  const { id } = await params;
  const row = await loadDraft(id, session.sub);
  if (!row) return NextResponse.json({ error: 'Draft not found' }, { status: 404 });
  if (row.status !== 'DRAFT') {
    return NextResponse.json({ error: 'This draft was already submitted' }, { status: 409 });
  }

  const parsed = ActionBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid action', issues: parsed.error.issues }, { status: 400 });
  }
  const body = parsed.data;

  try {
    switch (body.action) {
      case 'category':
        return NextResponse.json({ draft: await setCategory(row, body.categoryKey) });
      case 'answer':
        return NextResponse.json({
          draft: await answerSlot(
            row,
            body.slotKey,
            body.kind === 'VALUE' ? { kind: 'VALUE', value: body.value } : { kind: body.kind },
          ),
        });
      case 'message':
        return NextResponse.json({ draft: await addMessage(row, body.text, body.slotKey) });
      case 'edit':
        return NextResponse.json({ draft: await editSlot(row, body.slotKey) });
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not update the draft' },
      { status: 400 },
    );
  }
}
