/**
 * The Layer 5 gate, and the no-key run for it (plan.MD §9.5).
 *
 *   GROQ_API_KEY= npx tsx scripts/layer5-nokey.ts
 *
 * Submits the four spec §16 phrasings from four different student accounts,
 * through the real draft service and the real complaint creation path, with no
 * LLM available — and asserts they converge on ONE incident with an affected
 * count of 4, that students 2–4 are given the §36 incident message rather than a
 * generic acknowledgement, and that an unrelated complaint stays out of it.
 *
 * Dedup is entirely deterministic (CLAUDE.md §5) so the numbers here are the same
 * with a key set; the run goes through the service layer rather than HTTP because
 * Next 16 allows only one dev server per directory. `scripts/layer5-gate.sh`
 * covers the same ground over the API with four real logins.
 */
import 'dotenv/config';
import { prisma } from '@/lib/db';
import { getLlmProvider } from '@/lib/llm';
import { answerSlot, createDraft, loadDraft, locationIdOf, setCategory, toState } from '@/lib/drafts/service';
import { createComplaint } from '@/lib/complaints/create';
import { getCategory } from '@/lib/engine/schemas';
import { incidentMessage, isSharedIncident } from '@/lib/incidents/message';
import { mergeIntoIncident } from '@/lib/incidents/service';
import type { AnswerInput } from '@/lib/engine/draft';
import type { DraftView } from '@/lib/drafts/service';

/**
 * Spec §16 verbatim, except the floor: the seed's CSE Block has two floors, so
 * "third floor" becomes "2nd floor". The point of the case is that a *floor*
 * level report joins a *building* level one, which is unchanged.
 */
const CASES = [
  { email: 'student@campus.edu', text: "WiFi isn't working in CSE Block.", scope: 'BUILDING' },
  { email: 'student2@campus.edu', text: 'No internet connection in CSE building.', scope: 'MANY' },
  { email: 'student3@campus.edu', text: 'Network is down on the 2nd floor of CSE Block.', scope: 'MANY' },
  // No location, and scope never established — the hardest of the four, and the
  // one that proves an UNKNOWN scope bucket is a wildcard rather than a mismatch.
  { email: 'student4@campus.edu', text: 'Unable to connect to campus WiFi.', scope: null },
];

/**
 * The near miss: the right place, the wrong fault. Same building and same hour as
 * the outage, but "very slow" is not "no connection at all". A different
 * subcategory costs 0.55 × 0.65 of the score, which puts the total inside the
 * 0.45–0.70 band *whatever* the trigram similarity turns out to be — so this case
 * asserts the middle band rather than stumbling into it.
 */
const NEAR_MISS = {
  email: 'student3@campus.edu',
  text: 'The wifi is very slow in CSE Block.',
  scope: 'MANY' as string | null,
};

/** The control: a different problem in a different building, submitted the same minute. */
const CONTROL = {
  email: 'student2@campus.edu',
  text: 'I cannot log in to the campus wifi in the Central Library.',
  scope: 'FEW' as string | null,
};

async function main() {
  if (getLlmProvider().available) {
    throw new Error('GROQ_API_KEY is set — rerun as `GROQ_API_KEY= npx tsx scripts/layer5-nokey.ts`');
  }
  console.log('provider: null (no key) — dedup never consults an LLM anyway\n');

  await isolateRun();

  const problems: string[] = [];
  const submitted: { email: string; code: string; incidentId: string; incidentCode: string; affected: number; verdict: string; score: number; priority: string }[] = [];

  for (const testCase of [...CASES, NEAR_MISS, CONTROL]) {
    const isControl = testCase === CONTROL || testCase === NEAR_MISS;
    const student = await prisma.user.findUnique({ where: { email: testCase.email } });
    if (!student) throw new Error(`No seeded ${testCase.email} — run \`npm run db:seed\``);

    const { complaint, incident } = await submit(student.id, testCase.text, testCase.scope);

    submitted.push({
      email: testCase.email,
      code: complaint.code,
      incidentId: incident.incidentId,
      incidentCode: incident.incidentCode,
      affected: incident.affectedCount,
      verdict: incident.verdict,
      score: incident.score,
      priority: complaint.priority,
    });

    const shared = isSharedIncident(incident.affectedCount);
    const ack = shared
      ? incidentMessage({
          code: incident.incidentCode,
          title: incident.incidentTitle,
          status: incident.incidentStatus,
          priority: complaint.priority,
          affectedCount: incident.affectedCount,
          departmentName: complaint.department?.name ?? null,
        })
      : null;

    console.log(`${isControl ? '□' : '·'} ${testCase.email}: "${testCase.text}"`);
    console.log(
      `    ${complaint.code} ${complaint.priority} → ${incident.incidentCode} "${incident.incidentTitle}"`,
    );
    console.log(
      `    dedup ${incident.verdict.toLowerCase()} at ${incident.score.toFixed(2)} · ${incident.affectedCount} affected`,
    );
    console.log(`    student sees: ${ack ? `${ack.affectedLine} ${ack.reassurance}` : 'a generic acknowledgement'}`);
    console.log();
  }

  const four = submitted.slice(0, 4);
  const nearMiss = submitted[4];
  const control = submitted[5];

  // (1) §16 — four phrasings, one incident.
  const incidentIds = new Set(four.map((s) => s.incidentId));
  if (incidentIds.size !== 1) {
    problems.push(`the four phrasings landed on ${incidentIds.size} incidents: ${four.map((s) => s.incidentCode).join(', ')}`);
  }

  // (2) §18 — the affected count is students, not complaints.
  const incidentId = four[0].incidentId;
  const members = await prisma.complaint.findMany({
    where: { incidentId },
    select: { code: true, reporterId: true, priority: true },
  });
  const incident = await prisma.incident.findUnique({ where: { id: incidentId } });
  const distinctReporters = new Set(members.map((m) => m.reporterId)).size;

  if (incident?.affectedCount !== distinctReporters) {
    problems.push(`affectedCount ${incident?.affectedCount} but ${distinctReporters} distinct reporters`);
  }
  if (incident?.affectedCount !== 4) {
    problems.push(`expected affectedCount 4, got ${incident?.affectedCount}`);
  }

  // (3) §36 — students 2–4 are told about the incident, student 1 is not (there
  // was nothing to tell them about yet).
  if (isSharedIncident(four[0].affected)) {
    problems.push('the first reporter was shown an incident message for a solitary report');
  }
  for (const s of four.slice(1)) {
    if (!isSharedIncident(s.affected)) problems.push(`${s.email} got a generic ack instead of the incident message`);
  }

  // (4) The control keeps its own incident — dedup discriminates, it doesn't
  // just pool everything in a category.
  if (control.incidentId === incidentId) {
    problems.push('the unrelated library complaint was absorbed into the CSE incident');
  }

  // (5) Layer 4's promise survives: linking never re-bands a stored complaint.
  const rebanded = members.filter((m) => {
    const match = four.find((s) => s.code === m.code);
    return match && match.priority !== m.priority;
  });
  if (rebanded.length > 0) {
    problems.push(`linking changed the stored band of ${rebanded.map((m) => m.code).join(', ')}`);
  }

  // (6) §41 — the middle band asks a person rather than guessing, and the answer
  // takes effect through exactly the same link the automatic path uses.
  if (nearMiss.verdict !== 'SUGGESTED') {
    problems.push(`the near miss scored ${nearMiss.score.toFixed(2)} and was ruled ${nearMiss.verdict}, not SUGGESTED`);
  }
  if (nearMiss.incidentId === incidentId) {
    problems.push('a suggested duplicate was linked automatically instead of being put to staff');
  }

  const suggestionEvent = await prisma.complaintEvent.findFirst({
    where: { complaint: { code: nearMiss.code }, type: 'DUPLICATE_SUGGESTED' },
  });
  if (!suggestionEvent) problems.push('no DUPLICATE_SUGGESTED event was written for the near miss');
  if (suggestionEvent && !suggestionEvent.isInternal) {
    problems.push('the duplicate suggestion was visible to the student (§39)');
  }

  const staff = await prisma.user.findFirst({ where: { email: 'staff@campus.edu' } });
  const nearMissComplaint = await prisma.complaint.findUnique({ where: { code: nearMiss.code } });
  const merged = await mergeIntoIncident({
    complaintId: nearMissComplaint!.id,
    incidentId,
    actorId: staff!.id,
  });

  if ('error' in merged) {
    problems.push(`staff merge failed: ${merged.error}`);
  } else {
    // student3 already reported this issue, so confirming their second complaint
    // is a duplicate must not invent a fifth affected student (§18).
    if (merged.incident.affectedCount !== 4) {
      problems.push(`merging a repeat reporter changed the affected count to ${merged.incident.affectedCount}`);
    }
    const orphan = await prisma.incident.findUnique({ where: { id: nearMiss.incidentId } });
    if (orphan) problems.push(`${nearMiss.incidentCode} was left behind empty after the merge`);
    console.log(
      `merge: staff confirmed ${nearMiss.code} (scored ${nearMiss.score.toFixed(2)}) into ${merged.incident.code} — ${merged.incident.affectedCount} affected, ${nearMiss.incidentCode} collected\n`,
    );
  }

  const final = await prisma.incident.findUnique({
    where: { id: incidentId },
    include: { complaints: { orderBy: { createdAt: 'asc' }, select: { code: true } } },
  });
  console.log(`incident ${final?.code} "${final?.title}"`);
  console.log(`  priority ${final?.priority} · ${final?.affectedCount} students affected`);
  console.log(`  members: ${final?.complaints.map((m) => m.code).join(', ')}`);
  console.log(`  control: ${control.code} stayed in ${control.incidentCode}\n`);

  for (const problem of problems) console.log(`  FAIL: ${problem}`);
  console.log(
    problems.length === 0
      ? 'gate: four phrasings → one incident, 4 students affected, and the three later reporters were told so'
      : `gate: ${problems.length} failure(s)`,
  );

  await prisma.$disconnect();
  process.exit(problems.length === 0 ? 0 : 1);
}

/**
 * Earlier gate runs leave open NETWORK incidents in CSE Block, and the dedup
 * window is 24 hours — so without this the four complaints below would join a
 * previous run's incident and the count would be this run's plus history.
 * Closing them is the fixture, and it is announced rather than silent.
 */
async function isolateRun() {
  const stale = await prisma.incident.updateMany({
    where: { categoryKey: 'NETWORK', status: { in: ['OPEN', 'IN_PROGRESS'] } },
    data: { status: 'CLOSED' },
  });
  if (stale.count > 0) {
    console.log(`isolating: closed ${stale.count} pre-existing open NETWORK incident(s) from earlier runs\n`);
  }
}

async function submit(studentId: string, text: string, scope: string | null) {
  let view: DraftView = await createDraft(studentId, text);

  for (let turn = 0; turn < 14 && view.step.kind !== 'SUMMARY'; turn++) {
    const row = await loadDraft(view.id, studentId);
    if (!row) throw new Error('draft vanished');

    if (view.step.kind === 'CATEGORY') {
      // The four sentences all name wifi/internet/network explicitly, so this is
      // only reached if keyword classification failed — which is itself a finding.
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
      // §16's fourth student never says how widely it is affecting people. An
      // unanswered scope must not cost them the match.
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

  // A location question the opening sentence did not answer stays unanswered —
  // student 4 reported "campus WiFi" and genuinely has no building to give.
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
