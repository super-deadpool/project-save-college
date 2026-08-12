/**
 * The Layer 6 gate, run with no LLM available (plan.MD §9.6).
 *
 *   GROQ_API_KEY= npx tsx scripts/layer6-nokey.ts
 *
 * Drives one complaint through the whole of §19's happy path — submitted,
 * analyzed, assigned, accepted, worked on, a question to the student and their
 * answer, resolved, closed — and asserts that:
 *
 *   · submission itself records the two automatic steps, so §20's tracker is
 *     never empty for work that has already happened;
 *   · the stepper ticks every rung with a real timestamp taken from the events;
 *   · illegal, forbidden and unexplained moves are all refused;
 *   · `respondedAt` / `resolvedAt` / `closedAt` are stamped where Layer 8 will
 *     look for them;
 *   · an incident's status follows its members, and one incident-wide action
 *     moves every member — each through the same transition table.
 *
 * The lifecycle never consults the LLM, so these numbers are identical with a
 * key set. `scripts/layer6-gate.sh` covers the same ground over the API.
 */
import 'dotenv/config';
import { prisma } from '@/lib/db';
import { getLlmProvider } from '@/lib/llm';
import { answerSlot, createDraft, loadDraft, locationIdOf, setCategory, toState } from '@/lib/drafts/service';
import { createComplaint } from '@/lib/complaints/create';
import { getCategory } from '@/lib/engine/schemas';
import { applyIncidentStatus } from '@/lib/incidents/actions';
import { recordEvent, transition } from '@/lib/lifecycle/transition';
import { stepperFor } from '@/lib/lifecycle/stepper';
import { statusStamps, timelineEntry } from '@/lib/lifecycle/timeline';
import type { AnswerInput } from '@/lib/engine/draft';
import type { ComplaintStatus } from '@/generated/prisma/enums';
import type { DraftView } from '@/lib/drafts/service';

const problems: string[] = [];
const check = (ok: boolean, failure: string) => {
  if (!ok) problems.push(failure);
};

async function main() {
  if (getLlmProvider().available) {
    throw new Error('GROQ_API_KEY is set — rerun as `GROQ_API_KEY= npx tsx scripts/layer6-nokey.ts`');
  }
  console.log('provider: null (no key) — the lifecycle never consults an LLM anyway\n');

  await isolateRun();

  const [studentA, studentB, staff, manager] = await Promise.all([
    user('student@campus.edu'),
    user('student2@campus.edu'),
    user('staff@campus.edu'),
    user('manager@campus.edu'),
  ]);

  // Two students, one outage — so the incident has something to roll up.
  const first = await submit(studentA.id, "WiFi isn't working in CSE Block.", 'BUILDING');
  const second = await submit(studentB.id, 'No internet connection in CSE building.', 'MANY');

  console.log('── submission records the steps that already happened');
  console.log(`   ${first.complaint.code} ${first.complaint.status} · ${second.complaint.code} ${second.complaint.status}`);

  check(
    first.complaint.status === 'ASSIGNED',
    `a routed complaint stopped at ${first.complaint.status} instead of ASSIGNED`,
  );
  check(
    first.incident.incidentId === second.incident.incidentId,
    'the two reports did not land in one incident — the Layer 5 fixture is not holding',
  );

  const opening = await feed(first.complaint.id);
  console.log(opening.map((e) => `   ${time(e.at)}  ${e.headline}`).join('\n'));
  check(opening.length >= 3, `submission left ${opening.length} timeline entries, expected 3`);
  check(
    opening.some((e) => e.headline.startsWith('Assigned to ')),
    'the assignment step does not name the department (§20)',
  );

  console.log('\n── illegal moves are refused');
  const shortcut = await transition({
    complaintId: first.complaint.id,
    to: 'RESOLVED',
    actor: { id: staff.id, role: 'STAFF' },
  });
  report('staff resolving an unaccepted complaint', shortcut);
  check(!shortcut.ok, 'ASSIGNED → RESOLVED was allowed, skipping the response stamp entirely');

  const byStudent = await transition({
    complaintId: first.complaint.id,
    to: 'ACKNOWLEDGED',
    actor: { id: studentA.id, role: 'STUDENT' },
  });
  report('a student accepting their own complaint', byStudent);
  check(!byStudent.ok && byStudent.code === 'FORBIDDEN', 'a student was allowed into the staff workflow');

  const silentReject = await transition({
    complaintId: first.complaint.id,
    to: 'REJECTED',
    actor: { id: manager.id, role: 'DEPT_MANAGER' },
  });
  report('a manager rejecting with no reason', silentReject);
  check(!silentReject.ok && silentReject.code === 'NOTE_REQUIRED', 'a complaint was rejected with no explanation');

  console.log('\n── the happy path, as staff');
  await step(first.complaint.id, 'ACKNOWLEDGED', staff.id, 'STAFF', { assigneeId: staff.id });

  const midway = await prisma.incident.findUnique({ where: { id: first.incident.incidentId } });
  console.log(`   incident is now ${midway?.status} — one member is being handled`);
  check(midway?.status === 'IN_PROGRESS', `incident status is ${midway?.status}, expected IN_PROGRESS`);

  await recordEvent({
    complaintId: first.complaint.id,
    type: 'PROGRESS_UPDATE',
    actorId: staff.id,
    message: 'Access point in the corridor has failed — replacement on the way.',
  });
  await step(first.complaint.id, 'IN_PROGRESS', staff.id, 'STAFF');
  await step(first.complaint.id, 'WAITING_FOR_STUDENT', staff.id, 'STAFF', {
    note: 'Which room are you sitting in?',
  });
  await recordEvent({
    complaintId: first.complaint.id,
    type: 'INFO_PROVIDED',
    actorId: studentA.id,
    message: 'Room 302.',
  });
  await step(first.complaint.id, 'IN_PROGRESS', studentA.id, 'STUDENT');
  await step(first.complaint.id, 'RESOLVED', staff.id, 'STAFF', { note: 'Access point replaced.' });
  await step(first.complaint.id, 'CLOSED', studentA.id, 'STUDENT');

  const done = await prisma.complaint.findUnique({
    where: { id: first.complaint.id },
    select: { status: true, assigneeId: true, respondedAt: true, resolvedAt: true, closedAt: true },
  });
  check(done?.status === 'CLOSED', `the happy path ended at ${done?.status}`);
  check(done?.assigneeId === staff.id, 'accepting the complaint did not record who owns it');
  // Layer 8 measures its SLA against exactly these three.
  check(done?.respondedAt != null, 'respondedAt was never stamped');
  check(done?.resolvedAt != null, 'resolvedAt was never stamped');
  check(done?.closedAt != null, 'closedAt was never stamped');

  console.log('\n── §20: the student sees every step, with a time against it');
  const steps = await tracker(first.complaint.id);
  for (const s of steps) {
    console.log(
      `   ${s.state === 'DONE' ? '✓' : s.state === 'CURRENT' ? '●' : '○'} ${s.label.padEnd(24)}${s.at ? time(s.at) : ''}`,
    );
  }
  const untimed = steps.filter((s) => s.state !== 'PENDING' && !s.at);
  check(untimed.length === 0, `${untimed.length} reached step(s) carry no timestamp`);
  check(
    steps.every((s) => s.state === 'DONE' || (s.key === 'CLOSED' && s.state === 'CURRENT')),
    'a closed complaint still shows unreached steps',
  );

  const updates = await feed(first.complaint.id);
  console.log(`\n   ${updates.length} updates in the feed:`);
  console.log(updates.map((e) => `   ${time(e.at)}  ${e.headline}`).join('\n'));
  check(
    updates.some((e) => e.headline === 'Investigation started'),
    'the feed reports enum names rather than what happened',
  );

  console.log('\n── §17: one action on the incident moves every member');
  const before = await prisma.complaint.findUnique({
    where: { id: second.complaint.id },
    select: { status: true },
  });
  const bulk = await applyIncidentStatus({
    incidentId: first.incident.incidentId,
    to: 'RESOLVED',
    actor: { id: staff.id, role: 'STAFF' },
    note: 'Access point replaced — the whole block is back.',
    scopeDepartmentId: null,
  });
  if ('error' in bulk) {
    problems.push(`the incident-wide action failed: ${bulk.error}`);
  } else {
    console.log(
      `   applied to ${bulk.applied.map((a) => `${a.code} (${a.from} → ${a.to})`).join(', ') || 'nothing'}`,
    );
    console.log(`   left alone: ${bulk.skipped.map((s) => `${s.code} — ${s.reason}`).join(', ') || 'nothing'}`);
    check(
      bulk.applied.some((a) => a.code === second.complaint.code),
      `${second.complaint.code} was at ${before?.status} and the bulk resolve did not reach it`,
    );
    // The one the student already closed must not be dragged backwards.
    check(
      bulk.skipped.some((s) => s.code === first.complaint.code),
      'a complaint the student had already closed was moved by the bulk action',
    );
  }

  const walked = await feed(second.complaint.id);
  check(
    walked.some((e) => e.headline.includes('(with INC')),
    'a member moved by the incident does not say so on its own timeline',
  );
  const secondAfter = await prisma.complaint.findUnique({
    where: { id: second.complaint.id },
    select: { status: true, respondedAt: true },
  });
  check(
    secondAfter?.respondedAt != null,
    'the bulk resolve skipped the acknowledgement, leaving no response time',
  );

  const incident = await prisma.incident.findUnique({
    where: { id: first.incident.incidentId },
    select: { code: true, status: true, affectedCount: true, resolvedAt: true },
  });
  console.log(
    `\n   ${incident?.code}: ${incident?.status} · ${incident?.affectedCount} affected · resolved ${incident?.resolvedAt ? time(incident.resolvedAt) : 'never'}`,
  );
  check(
    incident?.status === 'RESOLVED',
    `the incident reads ${incident?.status} while every member is settled`,
  );

  console.log();
  for (const problem of problems) console.log(`  FAIL: ${problem}`);
  console.log(
    problems.length === 0
      ? 'gate: the full lifecycle ran, every step is timestamped, illegal moves were refused, and the incident followed its members'
      : `gate: ${problems.length} failure(s)`,
  );

  await prisma.$disconnect();
  process.exit(problems.length === 0 ? 0 : 1);
}

/** Earlier runs leave open NETWORK incidents inside the 24h dedup window. */
async function isolateRun() {
  const stale = await prisma.incident.updateMany({
    where: { categoryKey: 'NETWORK', status: { in: ['OPEN', 'IN_PROGRESS'] } },
    data: { status: 'CLOSED' },
  });
  if (stale.count > 0) {
    console.log(`isolating: closed ${stale.count} pre-existing open NETWORK incident(s) from earlier runs\n`);
  }
}

async function step(
  complaintId: string,
  to: ComplaintStatus,
  actorId: string,
  role: 'STAFF' | 'STUDENT' | 'DEPT_MANAGER' | 'ADMIN',
  extra: { note?: string; assigneeId?: string } = {},
) {
  const outcome = await transition({ complaintId, to, actor: { id: actorId, role }, ...extra });
  if (!outcome.ok) {
    problems.push(`${role} could not move the complaint to ${to}: ${outcome.reason}`);
    return;
  }
  console.log(`   ${role.toLowerCase()} → ${outcome.to.padEnd(20)} ${outcome.narration}`);
}

function report(what: string, outcome: { ok: boolean; reason?: string; code?: string }) {
  console.log(`   ${what}: ${outcome.ok ? 'ALLOWED' : `refused (${outcome.code}) — ${outcome.reason}`}`);
}

async function events(complaintId: string) {
  const rows = await prisma.complaintEvent.findMany({
    where: { complaintId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: { actor: true },
  });
  return rows.map((e) => ({
    id: e.id,
    type: e.type,
    message: e.message,
    meta: e.meta,
    isInternal: e.isInternal,
    createdAt: e.createdAt,
    actorName: e.actor?.name ?? null,
  }));
}

async function feed(complaintId: string) {
  return (await events(complaintId)).map(timelineEntry);
}

async function tracker(complaintId: string) {
  const complaint = await prisma.complaint.findUnique({
    where: { id: complaintId },
    include: { department: true },
  });
  return stepperFor({
    status: complaint!.status,
    stamps: statusStamps(await events(complaintId)),
    departmentName: complaint!.department?.name ?? null,
    submittedAt: complaint!.createdAt,
  });
}

const time = (at: Date) => at.toLocaleTimeString('en-IN');

async function user(email: string) {
  const row = await prisma.user.findUnique({ where: { email } });
  if (!row) throw new Error(`No seeded ${email} — run \`npm run db:seed\``);
  return row;
}

/** The same driver Layer 5's gate uses: a real conversation, then a real submission. */
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
