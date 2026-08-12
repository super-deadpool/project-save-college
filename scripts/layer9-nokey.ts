/**
 * The Layer 9 gate, run with no LLM available (plan.MD §9.5).
 *
 *   GROQ_API_KEY= npx tsx scripts/layer9-nokey.ts
 *
 * §23 and §24 through the service layer, both answers to both questions:
 *
 *   · resolve → the student declines → REOPENED with their reason, `reopenCount`
 *     up, the failed attempt's resolution stamp and SLA promise both torn up;
 *   · resolve again → the student confirms → CLOSED, with the confirmation
 *     recorded as its own event rather than inferred from the status;
 *   · a rating of the closed complaint, marked as confirming the fix, and refused
 *     the second time it is offered;
 *   · a complaint rated while still RESOLVED, which counts as an opinion of the
 *     work rather than a confirmation of it;
 *   · the refusals: somebody else's complaint, and a rating before there is
 *     anything to rate.
 *
 * `scripts/layer9-gate.sh` covers the same ground over the API.
 */
import 'dotenv/config';
import { prisma } from '@/lib/db';
import { getLlmProvider } from '@/lib/llm';
import { answerSlot, createDraft, loadDraft, locationIdOf, setCategory, toState } from '@/lib/drafts/service';
import { createComplaint } from '@/lib/complaints/create';
import { getCategory } from '@/lib/engine/schemas';
import { transition } from '@/lib/lifecycle/transition';
import { timelineEntry } from '@/lib/lifecycle/timeline';
import { confirmResolution, recordFeedback } from '@/lib/feedback/service';
import { satisfactionOf } from '@/lib/feedback/satisfaction';
import type { AnswerInput } from '@/lib/engine/draft';
import type { DraftView } from '@/lib/drafts/service';

const problems: string[] = [];
const check = (ok: boolean, failure: string) => {
  if (!ok) problems.push(failure);
};

async function main() {
  if (getLlmProvider().available) {
    throw new Error('GROQ_API_KEY is set — rerun as `GROQ_API_KEY= npx tsx scripts/layer9-nokey.ts`');
  }
  console.log('provider: null (no key) — §23 and §24 never consult an LLM\n');

  await isolateRun();
  const [student, other, staff] = await Promise.all([
    user('student@campus.edu'),
    user('student2@campus.edu'),
    user('staff.mnt@campus.edu'),
  ]);

  // ── the declined resolution
  console.log('── a resolution the student does not accept');
  const a = await submit(student.id, 'The tube light in CSE 101 keeps flickering.', 'ROOM');
  await workTo(a.complaint.id, staff.id, 'Choke replaced.');

  const early = await recordFeedback({ complaintId: a.complaint.id, actor: { id: student.id }, rating: 5 });
  // Rating is allowed on a RESOLVED complaint — it is the confirmation that is
  // not yet given — so this one succeeds and is *not* marked as confirmed.
  console.log(`   rating while still RESOLVED: ${early.ok ? `stored, confirmed=${early.feedback.resolutionConfirmed}` : early.reason}`);
  check(early.ok, 'a student could not rate a complaint their department had resolved');
  check(early.ok && !early.feedback.resolutionConfirmed, 'a rating given without confirming the fix claims to confirm it');

  const notYours = await confirmResolution({
    complaintId: a.complaint.id,
    actor: { id: other.id, role: 'STUDENT' },
    confirmed: true,
  });
  console.log(`   another student confirming it: ${notYours.ok ? 'ALLOWED' : `refused (${notYours.code})`}`);
  check(!notYours.ok && notYours.code === 'NOT_YOURS', "someone else answered §23 for the reporter");

  const silent = await confirmResolution({
    complaintId: a.complaint.id,
    actor: { id: student.id, role: 'STUDENT' },
    confirmed: false,
  });
  console.log(`   "still broken" with no explanation: ${silent.ok ? 'ALLOWED' : `refused (${silent.code})`}`);
  check(!silent.ok && silent.code === 'NO_REASON', 'a complaint was reopened with nothing for the department to act on');

  const declined = await confirmResolution({
    complaintId: a.complaint.id,
    actor: { id: student.id, role: 'STUDENT' },
    confirmed: false,
    reason: 'It flickered again the same evening.',
  });
  check(declined.ok, `declining the resolution failed: ${declined.ok ? '' : declined.reason}`);

  const reopened = await load(a.complaint.id);
  console.log(
    `   ${reopened.code} ${reopened.status} · reopened ${reopened.reopenCount}× · resolvedAt ${reopened.resolvedAt ? 'kept' : 'cleared'} · promise ${reopened.resolutionDueAt ? 'kept' : 'fresh'}`,
  );
  check(reopened.status === 'REOPENED', `expected REOPENED, got ${reopened.status}`);
  check(reopened.reopenCount === 1, `reopenCount is ${reopened.reopenCount}, expected 1`);
  check(reopened.resolvedAt == null, 'a reopened complaint still carries the resolution the student rejected');
  check(
    reopened.resolutionDueAt == null && reopened.escalationLevel === 0,
    'the failed attempt’s SLA promise and escalations survived the reopen (§23 re-flags the department)',
  );

  const declinedFeed = await feed(a.complaint.id);
  console.log(declinedFeed.slice(-3).map((e) => `   ${e.headline}${e.detail ? ` — ${e.detail}` : ''}`).join('\n'));
  check(
    declinedFeed.some((e) => e.headline === 'Resolution rejected'),
    'the feed does not record that the student rejected the resolution',
  );

  // ── the second attempt, accepted
  console.log('\n── the second attempt, which the student accepts');
  await workTo(a.complaint.id, staff.id, 'Whole fitting replaced.');
  const confirmed = await confirmResolution({
    complaintId: a.complaint.id,
    actor: { id: student.id, role: 'STUDENT' },
    confirmed: true,
  });
  check(confirmed.ok, `confirming failed: ${confirmed.ok ? '' : confirmed.reason}`);
  check(confirmed.ok && confirmed.ratingRequested, '§24 was not asked after §23 was answered');

  const closed = await load(a.complaint.id);
  console.log(`   ${closed.code} ${closed.status} · closedAt ${closed.closedAt ? 'stamped' : 'missing'}`);
  check(closed.status === 'CLOSED', `expected CLOSED, got ${closed.status}`);
  check(closed.closedAt != null, 'closing the complaint did not stamp closedAt');

  const confirmedFeed = await feed(a.complaint.id);
  check(
    confirmedFeed.some((e) => e.headline === 'Resolution confirmed'),
    'the confirmation is only inferable from the status, not recorded',
  );

  const repeat = await recordFeedback({ complaintId: a.complaint.id, actor: { id: student.id }, rating: 1 });
  console.log(`   rating it a second time: ${repeat.ok ? 'ALLOWED' : `refused (${repeat.code})`}`);
  check(!repeat.ok && repeat.code === 'ALREADY_RATED', 'a complaint could be rated twice, so the campus average is a click count');

  // ── the straightforward path
  console.log('\n── a complaint fixed first time, confirmed and rated');
  const b = await submit(student.id, 'The fan in room A-214 is not working.', 'ROOM');
  await workTo(b.complaint.id, staff.id, 'Capacitor replaced.');

  const tooEarly = await confirmResolution({
    complaintId: b.complaint.id,
    actor: { id: student.id, role: 'STUDENT' },
    confirmed: true,
  });
  check(tooEarly.ok, `confirming a resolved complaint failed: ${tooEarly.ok ? '' : tooEarly.reason}`);

  const rated = await recordFeedback({
    complaintId: b.complaint.id,
    actor: { id: student.id },
    rating: 5,
    comment: 'Same day. Thank you.',
  });
  check(rated.ok, `rating failed: ${rated.ok ? '' : rated.reason}`);
  check(rated.ok && rated.feedback.resolutionConfirmed, 'a rating after a confirmed fix is not marked as confirming it');

  const bClosed = await load(b.complaint.id);
  console.log(`   ${bClosed.code} ${bClosed.status} · rated ${rated.ok ? rated.feedback.rating : '—'}/5 (${rated.ok ? rated.feedback.label : ''})`);

  const nothingToRate = await recordFeedback({
    complaintId: (await submit(student.id, 'The projector in CSE 102 will not switch on.', 'ROOM')).complaint.id,
    actor: { id: student.id },
    rating: 3,
  });
  console.log(`   rating a complaint nobody has worked on: ${nothingToRate.ok ? 'ALLOWED' : `refused (${nothingToRate.code})`}`);
  check(!nothingToRate.ok && nothingToRate.code === 'NOT_FINISHED', 'an unresolved complaint could be rated');

  // ── what the ratings add up to (the input §31 and §34 read)
  console.log('\n── §24 aggregated, which is what §31 reports and §34 scores');
  const ratings = (await prisma.feedback.findMany({ select: { rating: true } })).map((f) => f.rating);
  const satisfaction = satisfactionOf(ratings);
  console.log(
    `   ${satisfaction.count} rating(s) · average ${satisfaction.average?.toFixed(2) ?? '—'} · ${satisfaction.positiveRate != null ? `${Math.round(satisfaction.positiveRate * 100)}% positive` : 'no positive rate'}`,
  );
  check(satisfaction.count >= 3, `only ${satisfaction.count} ratings landed in the table, expected at least 3`);
  check(satisfaction.average != null, 'the campus has ratings but no average');

  console.log();
  for (const problem of problems) console.log(`  FAIL: ${problem}`);
  console.log(
    problems.length === 0
      ? 'gate: a resolution ends only when the student says so — declining reopens with a reason and a fresh promise, confirming closes and is rated once, and both questions are the reporter’s alone'
      : `gate: ${problems.length} failure(s)`,
  );

  await prisma.$disconnect();
  process.exit(problems.length === 0 ? 0 : 1);
}

/** Earlier runs leave open incidents inside the dedup window. */
async function isolateRun() {
  const stale = await prisma.incident.updateMany({
    where: { categoryKey: { in: ['ELECTRICAL', 'CLASSROOM', 'HOSTEL'] }, status: { in: ['OPEN', 'IN_PROGRESS'] } },
    data: { status: 'CLOSED' },
  });
  if (stale.count > 0) {
    console.log(`isolating: closed ${stale.count} pre-existing open incident(s) from earlier runs\n`);
  }
}

/** Accept → work → resolve, as the owning department. */
async function workTo(complaintId: string, staffId: string, note: string) {
  // ASSIGNED and REOPENED are both one rung below ACKNOWLEDGED, which is where
  // the response stamp and the new SLA clock come from.
  await transition({ complaintId, to: 'ACKNOWLEDGED', actor: { id: staffId, role: 'STAFF' }, assigneeId: staffId });
  await transition({ complaintId, to: 'IN_PROGRESS', actor: { id: staffId, role: 'STAFF' } });
  const resolved = await transition({
    complaintId,
    to: 'RESOLVED',
    actor: { id: staffId, role: 'STAFF' },
    note,
  });
  if (!resolved.ok) problems.push(`could not resolve the complaint: ${resolved.reason}`);
}

async function load(id: string) {
  const row = await prisma.complaint.findUnique({ where: { id } });
  if (!row) throw new Error(`complaint ${id} vanished`);
  return row;
}

async function feed(complaintId: string) {
  const rows = await prisma.complaintEvent.findMany({
    where: { complaintId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: { actor: true },
  });
  return rows.map((e) =>
    timelineEntry({
      id: e.id,
      type: e.type,
      message: e.message,
      meta: e.meta,
      isInternal: e.isInternal,
      createdAt: e.createdAt,
      actorName: e.actor?.name ?? null,
    }),
  );
}

async function user(email: string) {
  const row = await prisma.user.findUnique({ where: { email } });
  if (!row) throw new Error(`No seeded ${email} — run \`npm run db:seed\``);
  return row;
}

/** The same driver the Layer 5, 6 and 8 gates use: a real conversation, then a real submission. */
async function submit(studentId: string, text: string, scope: string | null) {
  let view: DraftView = await createDraft(studentId, text);

  for (let turn = 0; turn < 14 && view.step.kind !== 'SUMMARY'; turn++) {
    const row = await loadDraft(view.id, studentId);
    if (!row) throw new Error('draft vanished');

    if (view.step.kind === 'CATEGORY') {
      view = await setCategory(row, view.step.categories[0].key);
      continue;
    }
    view = await answerSlot(row, view.step.slotKey, answerFor(view.categoryKey, view.step, scope));
  }

  if (view.step.kind !== 'SUMMARY') {
    throw new Error(`"${text}" never reached a summary (stuck on ${view.step.kind})`);
  }

  const row = await loadDraft(view.id, studentId);
  const state = toState(row!);
  const schema = getCategory(state.categoryKey)!;

  return createComplaint({
    reporterId: studentId,
    categoryKey: schema.key,
    locationId: locationIdOf(state.slots),
    slots: state.slots,
    rawText: state.rawText,
  });
}

function answerFor(
  categoryKey: string | null,
  step: { slotKey: string; type: string; options: { value: string }[] },
  scope: string | null,
): AnswerInput {
  const slot = categoryKey ? getCategory(categoryKey)?.slots.find((s) => s.key === step.slotKey) : null;
  const values = step.options.map((o) => o.value);
  const has = (v: string) => values.includes(v);

  switch (slot?.signal) {
    case 'SCOPE':
      return scope && has(scope) ? { kind: 'VALUE', value: scope } : { kind: 'UNSURE' };
    case 'DURATION':
      return { kind: 'VALUE', value: has('TODAY') ? 'TODAY' : values[0] };
    case 'IMPACT':
      return { kind: 'VALUE', value: has('NONE') ? 'NONE' : values[0] };
    case 'RECURRING':
      return { kind: 'VALUE', value: false };
    default:
      break;
  }

  if (step.type === 'location') return { kind: 'UNSURE' };
  if (step.type === 'boolean') return { kind: 'VALUE', value: false };
  if (values.length === 0) return { kind: 'UNSURE' };

  const pick = has('NONE') ? 'NONE' : values[0];
  return { kind: 'VALUE', value: step.type === 'multi' ? [pick] : pick };
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
