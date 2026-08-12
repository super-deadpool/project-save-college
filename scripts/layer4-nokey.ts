/**
 * The no-key run (plan.MD §9.5), repeated for Layer 4.
 *
 *   GROQ_API_KEY= npx tsx scripts/layer4-nokey.ts
 *
 * Drives complete conversations through the real draft service and the real
 * complaint creation path with no LLM available, and asserts that each one still
 * reaches a submitted complaint carrying a priority, its reasons, a department and
 * a dedup signature. Nothing here mocks the provider — it asserts the app picked
 * the null provider on its own.
 *
 * It goes through the service layer rather than HTTP because Next 16 allows only
 * one dev server per directory; `scripts/layer4-gate.sh` covers the API surface.
 */
import 'dotenv/config';
import { prisma } from '@/lib/db';
import { getLlmProvider } from '@/lib/llm';
import { createDraft, answerSlot, loadDraft, locationIdOf, setCategory, toState } from '@/lib/drafts/service';
import { createComplaint } from '@/lib/complaints/create';
import { getCategory } from '@/lib/engine/schemas';
import { studentReasons } from '@/lib/engine/priority';
import type { AnswerInput } from '@/lib/engine/draft';

const CASES = [
  'There is exposed electrical wiring near the hostel entrance in Boys Hostel A',
  'No internet at all in the whole of CSE Block since yesterday and I have an exam tomorrow',
  'The mess food was stale at dinner in Boys Hostel A Mess',
  'Water is leaking from a burst pipe in Boys Hostel A',
  'A chair is broken in CSE 101',
];

async function main() {
  if (getLlmProvider().available) {
    throw new Error('GROQ_API_KEY is set — rerun as `GROQ_API_KEY= npx tsx scripts/layer4-nokey.ts`');
  }
  console.log('provider: null (no key) — every extraction below is keyword-only\n');

  const student = await prisma.user.findFirst({ where: { role: 'STUDENT' } });
  if (!student) throw new Error('No seeded student — run `npm run db:seed`');

  let failures = 0;

  for (const text of CASES) {
    let view = await createDraft(student.id, text);

    // Answer whatever is asked, benignly, until the summary.
    for (let turn = 0; turn < 14 && view.step.kind !== 'SUMMARY'; turn++) {
      const row = await loadDraft(view.id, student.id);
      if (!row) throw new Error('draft vanished');

      if (view.step.kind === 'CATEGORY') {
        view = await setCategory(row, view.step.categories[0].key);
        continue;
      }

      const step = view.step;
      view = await answerSlot(row, step.slotKey, answerFor(view.categoryKey, step));
    }

    if (view.step.kind !== 'SUMMARY') {
      console.log(`✗ ${text}\n  never reached a summary (stuck on ${view.step.kind})\n`);
      failures += 1;
      continue;
    }

    const shown = view.step.assessment;
    const row = await loadDraft(view.id, student.id);
    const state = toState(row!);
    const schema = getCategory(state.categoryKey)!;

    const { complaint, assessment } = await createComplaint({
      reporterId: student.id,
      categoryKey: schema.key,
      locationId: locationIdOf(state.slots),
      slots: state.slots,
      rawText: state.rawText,
    });

    const problems: string[] = [];
    if (!shown) problems.push('summary carried no assessment');
    if (shown && shown.priority !== complaint.priority) {
      problems.push(`shown ${shown.priority} but stored ${complaint.priority}`);
    }
    if (studentReasons(assessment.priority).length === 0) problems.push('no reasons (§14)');
    if (!complaint.signature) problems.push('no dedup signature');
    if (!complaint.departmentId && !complaint.needsTriage) {
      problems.push('unrouted but not flagged for triage');
    }

    if (problems.length > 0) failures += 1;
    console.log(`${problems.length === 0 ? '✓' : '✗'} ${text}`);
    console.log(`  ${complaint.code} ${complaint.priority} (score ${complaint.priorityScore}) → ${
      complaint.department?.name ?? 'triage'
    }`);
    console.log(`  signature ${complaint.signature}`);
    for (const reason of studentReasons(assessment.priority)) console.log(`    · ${reason}`);
    for (const problem of problems) console.log(`    FAIL: ${problem}`);
    console.log();
  }

  console.log(
    failures === 0
      ? 'no-key run: every complaint completed, was prioritised with reasons, and was routed'
      : `no-key run: ${failures} case(s) failed`,
  );
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

/**
 * Answers a question the way a plausible student would, which matters because the
 * point of the run is a believable end-to-end result, not just a terminating loop:
 * modest circumstances, honest safety answers, first option otherwise.
 */
function answerFor(
  categoryKey: string | null,
  step: { slotKey: string; type: string; options: { value: string }[] },
): AnswerInput {
  const slot = categoryKey ? getCategory(categoryKey)?.slots.find((s) => s.key === step.slotKey) : null;
  const values = step.options.map((o) => o.value);
  const has = (v: string) => values.includes(v);

  switch (slot?.signal) {
    case 'SCOPE':
      return { kind: 'VALUE', value: has('FEW') ? 'FEW' : values[0] };
    case 'DURATION':
      return { kind: 'VALUE', value: has('TODAY') ? 'TODAY' : values[0] };
    case 'IMPACT':
      return { kind: 'VALUE', value: has('NONE') ? 'NONE' : values[0] };
    case 'RECURRING':
      return { kind: 'VALUE', value: false };
    case 'PERSON_AT_RISK':
      // The honest answer for a wire at a hostel entrance — and the one that
      // exercises the override.
      return { kind: 'VALUE', value: true };
    default:
      break;
  }

  if (step.type === 'boolean') return { kind: 'VALUE', value: false };
  if (values.length === 0) return { kind: 'UNSURE' };

  // A safety slot with nothing to report says so; anything else takes its first
  // option, which is the most serious one each schema lists.
  const pick = has('NONE') ? 'NONE' : has('NOBODY_UNWELL') ? 'NOBODY_UNWELL' : values[0];
  return { kind: 'VALUE', value: step.type === 'multi' ? [pick] : pick };
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
