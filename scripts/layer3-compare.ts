/**
 * Layer 3 evidence: rules vs LLM on the same sentence, same engine.
 *
 *   npx tsx scripts/layer3-compare.ts
 *
 * Runs both extractors over each sentence and walks the conversation with a
 * *faithful* answerer — it answers what the sentence actually says, so a hazard
 * detected by either path unlocks the same follow-up question in both. Anything
 * the sentence doesn't state is answered "I'm not sure".
 */
import 'dotenv/config';
import { getCategory } from '@/lib/engine/schemas';
import { extractWithLlm } from '@/lib/engine/extract';
import { applyAnswer, emptyDraft, mergeExtracted, nextStep } from '@/lib/engine/draft';
import { getLlmProvider, nullProvider } from '@/lib/llm';
import { listLocations } from '@/lib/locations';
import type { AnswerInput } from '@/lib/engine/draft';
import type { LlmProvider } from '@/lib/llm/provider';

const CASES: { text: string; category: string; answers: Record<string, AnswerInput> }[] = [
  {
    text: 'There is exposed electrical wiring near the hostel entrance in Boys Hostel A',
    category: 'ELECTRICAL',
    answers: {
      safety_hazard: { kind: 'VALUE', value: ['EXPOSED_WIRE'] },
      person_at_risk: { kind: 'VALUE', value: true },
      problem_type: { kind: 'VALUE', value: 'EXPOSED_WIRING' },
    },
  },
  {
    text: 'No power in the whole of Boys Hostel A since yesterday, nothing sparking or smoking, and I have an exam tomorrow',
    category: 'ELECTRICAL',
    answers: {
      safety_hazard: { kind: 'VALUE', value: ['NONE'] },
      problem_type: { kind: 'VALUE', value: 'NO_POWER' },
      scope: { kind: 'VALUE', value: 'BUILDING' },
      duration: { kind: 'VALUE', value: 'ONE_DAY' },
      impact: { kind: 'VALUE', value: 'EXAM' },
    },
  },
  {
    text: 'nobody in my wing of Boys Hostel A can get online since last night',
    category: 'NETWORK',
    answers: {
      problem_type: { kind: 'VALUE', value: 'NO_CONNECTION' },
      scope: { kind: 'VALUE', value: 'MANY' },
      duration: { kind: 'VALUE', value: 'ONE_DAY' },
    },
  },
];

async function walk(
  text: string,
  answers: Record<string, AnswerInput>,
  provider: LlmProvider,
  expectedCategory: string,
) {
  const locations = (await listLocations()).map((l) => ({ id: l.id, name: l.name, aliases: [l.code] }));
  const extraction = await extractWithLlm(text, null, { locations }, provider);
  const asked: string[] = [];

  let schema = getCategory(extraction.categoryKey);
  let slots = extraction.slots;
  if (!schema) {
    // The engine would show the category picker — that is an interaction too, and
    // then re-extract against the now-known slot set (mirrors setCategory()).
    asked.push('«pick a category»');
    schema = getCategory(expectedCategory)!;
    slots = (await extractWithLlm(text, schema, { locations }, provider)).slots;
  }

  let state = mergeExtracted(schema, emptyDraft(text), slots);
  const prefilled = Object.entries(state.slots).map(
    ([k, v]) => `${k}=${JSON.stringify(v.value)}`,
  );

  for (let i = 0; i < 12; i++) {
    const step = nextStep(schema, state);
    if (step.kind !== 'QUESTION') break;
    asked.push(step.slot.key);
    state = applyAnswer(schema, state, step.slot.key, answers[step.slot.key] ?? { kind: 'UNSURE' });
  }

  return { category: schema.key, source: extraction.source, prefilled, asked };
}

async function main() {
  const provider = getLlmProvider();
  console.log(`provider: ${provider.name}\n`);

  for (const c of CASES) {
    const rules = await walk(c.text, c.answers, nullProvider, c.category);
    const llm = await walk(c.text, c.answers, provider, c.category);
    console.log(`"${c.text}"`);
    console.log(`  rules : ${rules.category} · asks ${rules.asked.length} [${rules.asked}]`);
    console.log(`          prefilled ${rules.prefilled.join(' ')}`);
    console.log(`  llm   : ${llm.category} (${llm.source}) · asks ${llm.asked.length} [${llm.asked}]`);
    console.log(`          prefilled ${llm.prefilled.join(' ')}`);
    console.log(`  → ${rules.asked.length - llm.asked.length} fewer interactions\n`);
  }

  // listLocations holds a pooled Prisma connection open.
  process.exit(0);
}

void main();
