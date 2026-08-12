/**
 * The Layer 8 gate, run with no LLM available (plan.MD §9.5).
 *
 *   GROQ_API_KEY= npx tsx scripts/layer8-nokey.ts
 *
 * §22 end to end, through the service layer:
 *
 *   · a complaint picks up both deadlines the moment it reaches a department,
 *     and they match that department's own SLA profile for its band;
 *   · aged past the response window it escalates to the department manager,
 *     past the resolution window to the administrator, and past twice the
 *     resolution window it is flagged — each rung with its own two events;
 *   · a second scan a second later changes nothing, which is what makes running
 *     the sweep every minute safe;
 *   · a complaint that *was* answered in time skips the response rung entirely
 *     rather than being given a failure that never happened;
 *   · settled work is never escalated, and reopening tears up the old promise
 *     and issues a fresh one.
 *
 * None of this consults the LLM, so the numbers are identical with a key set;
 * `scripts/layer8-gate.sh` covers the same ground over the API with the dev
 * clock.
 */
import 'dotenv/config';
import { prisma } from '@/lib/db';
import { getLlmProvider } from '@/lib/llm';
import { answerSlot, createDraft, loadDraft, locationIdOf, setCategory, toState } from '@/lib/drafts/service';
import { createComplaint } from '@/lib/complaints/create';
import { getCategory } from '@/lib/engine/schemas';
import { transition } from '@/lib/lifecycle/transition';
import { timelineEntry } from '@/lib/lifecycle/timeline';
import { slaState } from '@/lib/sla/breach';
import { describeMinutes, minutesBetween, windowFor } from '@/lib/sla/due';
import { ageComplaints } from '@/lib/sla/dev-clock';
import { scanSla } from '@/lib/sla/service';
import { slaRisk } from '@/lib/queue/rank';
import type { AnswerInput } from '@/lib/engine/draft';
import type { DraftView } from '@/lib/drafts/service';

const problems: string[] = [];
const check = (ok: boolean, failure: string) => {
  if (!ok) problems.push(failure);
};

async function main() {
  if (getLlmProvider().available) {
    throw new Error('GROQ_API_KEY is set — rerun as `GROQ_API_KEY= npx tsx scripts/layer8-nokey.ts`');
  }
  console.log('provider: null (no key) — SLA math never consults an LLM anyway\n');

  await isolateRun();
  const [student, staff] = await Promise.all([user('student@campus.edu'), user('staff@campus.edu')]);

  // ── the promise
  console.log('── a complaint picks up its deadlines when it reaches a department');
  const forgotten = await submit(student.id, "WiFi isn't working in CSE Block.", 'BUILDING');
  const one = await load(forgotten.complaint.id);

  console.log(
    `   ${one.code} ${one.priority} · response due ${stamp(one.responseDueAt)} · resolution due ${stamp(one.resolutionDueAt)}`,
  );
  check(one.status === 'ASSIGNED', `the complaint stopped at ${one.status}, so no promise was made`);
  check(one.responseDueAt != null && one.resolutionDueAt != null, 'assignment left the complaint with no due dates');

  // The windows must be the ones this department actually promises, not defaults.
  const profile = await prisma.department
    .findUnique({ where: { id: one.departmentId! }, select: { slaProfile: true } })
    .then((d) => d?.slaProfile ?? null);
  const expected = windowFor(profile, one.priority);
  const gotResponse = minutesBetween(one.createdAt, one.responseDueAt!);
  const gotResolution = minutesBetween(one.createdAt, one.resolutionDueAt!);
  console.log(
    `   ${one.priority} on this department's profile: ${describeMinutes(expected.responseMinutes)} to respond, ${describeMinutes(expected.resolutionMinutes)} to resolve`,
  );
  check(
    Math.abs(gotResponse - expected.responseMinutes) < 1,
    `response window is ${gotResponse.toFixed(1)} min, the profile says ${expected.responseMinutes}`,
  );
  check(
    Math.abs(gotResolution - expected.resolutionMinutes) < 1,
    `resolution window is ${gotResolution.toFixed(1)} min, the profile says ${expected.resolutionMinutes}`,
  );
  check(one.escalationLevel === 0, 'a brand-new complaint is already escalated');
  check(slaRisk(one, new Date()) === 'OK', 'a complaint inside both windows reads as at risk');

  // ── rung 1: nobody answered
  console.log('\n── rung 1: nobody answered inside the response window');
  await ageComplaints([one.id], expected.responseMinutes + 5);
  const first = await scanSla();
  reportScan(first);
  const afterFirst = await load(one.id);
  check(afterFirst.escalationLevel === 1, `expected rung 1, got ${afterFirst.escalationLevel}`);
  check(
    first.escalated.some((e) => e.code === one.code && e.steps.every((s) => s.notify === 'DEPT_MANAGER')),
    'the response breach did not go to the department manager (§22)',
  );
  check(slaRisk(afterFirst, new Date()) === 'BREACHED', 'the queue does not show the breach it just escalated');

  const feedAfterFirst = await feed(one.id);
  console.log(feedAfterFirst.slice(-2).map((e) => `   ${e.headline}${e.detail ? ` — ${e.detail}` : ''}`).join('\n'));
  check(
    feedAfterFirst.some((e) => e.headline === 'Response time exceeded'),
    'the breach is not named in the feed (§20 reads words, not enums)',
  );
  check(
    feedAfterFirst.some((e) => e.headline.startsWith('Escalated to the department manager')),
    'the feed does not say who the complaint was escalated to',
  );

  // ── the sweep is idempotent
  console.log('\n── a second sweep a moment later changes nothing');
  const eventsBefore = await prisma.complaintEvent.count({ where: { complaintId: one.id } });
  const rescan = await scanSla();
  const eventsAfter = await prisma.complaintEvent.count({ where: { complaintId: one.id } });
  console.log(`   ${eventsBefore} events before · ${eventsAfter} after · escalated ${rescan.escalated.length}`);
  check(eventsAfter === eventsBefore, `a rescan wrote ${eventsAfter - eventsBefore} duplicate event(s)`);
  check(
    !rescan.escalated.some((e) => e.code === one.code),
    'the same complaint was escalated twice for the same failure',
  );

  // ── rung 2 and rung 3
  console.log('\n── rungs 2 and 3: past the resolution deadline, then past twice it');
  await ageComplaints([one.id], expected.resolutionMinutes - expected.responseMinutes + 5);
  const second = await scanSla();
  reportScan(second);
  const afterSecond = await load(one.id);
  check(afterSecond.escalationLevel === 2, `expected rung 2, got ${afterSecond.escalationLevel}`);
  check(
    second.escalated.some((e) => e.code === one.code && e.steps.some((s) => s.notify === 'ADMIN')),
    'the resolution breach did not reach the administrator (§22)',
  );

  await ageComplaints([one.id], expected.resolutionMinutes);
  const third = await scanSla();
  reportScan(third);
  const afterThird = await load(one.id);
  check(afterThird.escalationLevel === 3, `expected rung 3, got ${afterThird.escalationLevel}`);
  check(
    third.escalated.some((e) => e.code === one.code && e.steps.some((s) => s.flagged)),
    'twice the resolution window passed without the complaint being flagged',
  );
  const flaggedFeed = await feed(one.id);
  check(
    flaggedFeed.some((e) => e.headline === 'Twice the resolution time exceeded'),
    'the last rung is not distinguishable in the feed from an ordinary resolution breach',
  );

  // ── a rung that did not fail is not walked
  console.log('\n── a complaint answered on time skips the response rung');
  const answered = await submit(student.id, 'The tube light in CSE 101 is flickering.', 'ROOM');
  await transition({
    complaintId: answered.complaint.id,
    to: 'ACKNOWLEDGED',
    actor: { id: staff.id, role: 'STAFF' },
    assigneeId: staff.id,
  });
  const answeredRow = await load(answered.complaint.id);
  const answeredWindow = windowFor(
    await prisma.department
      .findUnique({ where: { id: answeredRow.departmentId! }, select: { slaProfile: true } })
      .then((d) => d?.slaProfile ?? null),
    answeredRow.priority,
  );
  await ageComplaints([answeredRow.id], answeredWindow.resolutionMinutes + 10);
  const skipping = await scanSla({ complaintId: answeredRow.id });
  reportScan(skipping);
  const afterSkip = await load(answeredRow.id);
  check(afterSkip.escalationLevel === 2, `expected a jump straight to rung 2, got ${afterSkip.escalationLevel}`);
  const skipFeed = await feed(answeredRow.id);
  check(
    !skipFeed.some((e) => e.headline === 'Response time exceeded'),
    'a complaint that was answered on time was given a response failure on the way up the ladder',
  );

  // ── settled work is left alone
  console.log('\n── settled work is never escalated');
  await transition({ complaintId: answeredRow.id, to: 'IN_PROGRESS', actor: { id: staff.id, role: 'STAFF' } });
  await transition({
    complaintId: answeredRow.id,
    to: 'RESOLVED',
    actor: { id: staff.id, role: 'STAFF' },
    note: 'Tube light replaced.',
  });
  const resolved = await load(answeredRow.id);
  const quiet = await scanSla({ complaintId: resolved.id });
  console.log(`   ${resolved.code} is ${resolved.status}: scanned ${quiet.scanned}, escalated ${quiet.escalated.length}`);
  check(quiet.escalated.length === 0, 'a resolved complaint was escalated');
  check(
    slaState(resolved, new Date()).level === 0 && slaRisk(resolved, new Date()) === 'NONE',
    'finished work still reads as breaching its promise',
  );

  // ── reopening issues a fresh promise
  console.log('\n── reopening tears up the old promise and issues a new one');
  await transition({
    complaintId: resolved.id,
    to: 'REOPENED',
    actor: { id: student.id, role: 'STUDENT' },
    note: 'It started flickering again the same evening.',
  });
  const reopened = await load(resolved.id);
  console.log(
    `   ${reopened.code} ${reopened.status} · rung ${reopened.escalationLevel} · response due ${stamp(reopened.responseDueAt)}`,
  );
  check(reopened.responseDueAt == null && reopened.resolutionDueAt == null, 'a reopened complaint kept its old deadlines');
  check(reopened.escalationLevel === 0, 'a reopened complaint kept the escalations of the round before it');
  check(reopened.respondedAt == null, 'a reopened complaint still counts the old acknowledgement as its response');
  check(reopened.reopenCount === 1, `reopenCount is ${reopened.reopenCount}, expected 1`);

  await transition({
    complaintId: reopened.id,
    to: 'ACKNOWLEDGED',
    actor: { id: staff.id, role: 'STAFF' },
    assigneeId: staff.id,
  });
  const restarted = await load(reopened.id);
  console.log(`   picked up again: response due ${stamp(restarted.responseDueAt)} · resolution due ${stamp(restarted.resolutionDueAt)}`);
  check(
    restarted.responseDueAt != null && restarted.resolutionDueAt != null,
    'picking a reopened complaint back up did not start a new SLA clock',
  );

  console.log();
  for (const problem of problems) console.log(`  FAIL: ${problem}`);
  console.log(
    problems.length === 0
      ? 'gate: due dates come from the department profile, §22 escalates one rung per real failure, the sweep is idempotent, and a reopen starts a fresh promise'
      : `gate: ${problems.length} failure(s)`,
  );

  await prisma.$disconnect();
  process.exit(problems.length === 0 ? 0 : 1);
}

/** Earlier runs leave open incidents inside the dedup window. */
async function isolateRun() {
  const stale = await prisma.incident.updateMany({
    where: { categoryKey: { in: ['NETWORK', 'ELECTRICAL'] }, status: { in: ['OPEN', 'IN_PROGRESS'] } },
    data: { status: 'CLOSED' },
  });
  if (stale.count > 0) {
    console.log(`isolating: closed ${stale.count} pre-existing open incident(s) from earlier runs\n`);
  }
}

function reportScan(result: Awaited<ReturnType<typeof scanSla>>) {
  console.log(
    `   sweep: ${result.scanned} with a live promise · ${result.breaching} past a deadline · ${result.escalated.length} escalated`,
  );
  for (const item of result.escalated) {
    console.log(
      `   ${item.code} ${item.from} → ${item.to}: ${item.steps.map((s) => `${s.kind}→${s.notify}${s.flagged ? ' (flagged)' : ''}`).join(', ')}`,
    );
  }
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

const stamp = (at: Date | null) => (at ? at.toLocaleString('en-IN') : 'none');

async function user(email: string) {
  const row = await prisma.user.findUnique({ where: { email } });
  if (!row) throw new Error(`No seeded ${email} — run \`npm run db:seed\``);
  return row;
}

/** The same driver the Layer 5 and 6 gates use: a real conversation, then a real submission. */
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
