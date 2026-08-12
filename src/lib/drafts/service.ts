import { prisma } from '@/lib/db';
import { CATEGORY_SCHEMAS, getCategory } from '@/lib/engine/schemas';
import { extractWithLlm } from '@/lib/engine/extract';
import { getLlmProvider } from '@/lib/llm';
import {
  addTurn,
  applyAnswer,
  clearAnswer,
  emptyDraft,
  markAsked,
  mergeExtracted,
  nextStep,
  type AnswerInput,
} from '@/lib/engine/draft';
import { summaryLines } from '@/lib/engine/summary';
import {
  assessComplaint,
  studentFacingAssessment,
  type StudentFacingAssessment,
} from '@/lib/complaints/assess';
import { listLocations } from '@/lib/locations';
import type { CategorySchema, DraftState, SlotOption, SlotValues, Turn } from '@/lib/engine/types';

/** What the chat UI needs to render one step of the conversation. */
export interface DraftView {
  id: string;
  rawText: string;
  categoryKey: string | null;
  categoryLabel: string | null;
  turns: Turn[];
  step:
    | { kind: 'CATEGORY'; categories: { key: string; label: string; description: string }[] }
    | {
        kind: 'QUESTION';
        slotKey: string;
        question: string;
        type: string;
        options: SlotOption[];
        allowUnsure: boolean;
        allowSkip: boolean;
        safetyCritical: boolean;
        placeholder?: string;
      }
    | {
        kind: 'SUMMARY';
        reason: string | null;
        safetyShortCircuit: boolean;
        /**
         * §12 — the summary states the priority and the responsible department
         * before submission, so this is the real assessment, not a preview of a
         * different calculation.
         */
        assessment: StudentFacingAssessment | null;
      };
  summary: { slotKey: string; label: string; display: string; state: string }[];
  askedCount: number;
  canSubmit: boolean;
  complaintId: string | null;
  extractionSource: 'RULES' | 'LLM' | null;
}

type DraftRow = {
  id: string;
  rawText: string;
  categoryKey: string | null;
  slots: unknown;
  askedSlots: string[];
  turns: unknown;
  complaintId: string | null;
};

export function toState(row: DraftRow): DraftState {
  return {
    rawText: row.rawText,
    categoryKey: row.categoryKey,
    slots: (row.slots ?? {}) as SlotValues,
    askedSlots: row.askedSlots ?? [],
    turns: (row.turns ?? []) as Turn[],
  };
}

async function locationHints() {
  const rows = await listLocations();
  return rows.map((l) => ({ id: l.id, name: l.name, aliases: [l.code] }));
}

export async function createDraft(userId: string, rawText: string) {
  const locations = await locationHints();
  const extraction = await extractWithLlm(rawText, null, { locations }, getLlmProvider());
  const schema = getCategory(extraction.categoryKey);

  let state = emptyDraft(rawText);
  state = addTurn(state, { role: 'USER', text: rawText }, new Date().toISOString());
  if (schema) {
    state = { ...state, categoryKey: schema.key };
    state = mergeExtracted(schema, state, extraction.slots);
  }

  const row = await prisma.complaintDraft.create({
    data: {
      userId,
      rawText,
      categoryKey: state.categoryKey,
      slots: state.slots as never,
      askedSlots: state.askedSlots,
      turns: state.turns as never,
    },
  });

  return buildView(row, state, extraction.source);
}

export async function loadDraft(id: string, userId: string) {
  const row = await prisma.complaintDraft.findFirst({ where: { id, userId } });
  return row;
}

async function persist(id: string, state: DraftState) {
  return prisma.complaintDraft.update({
    where: { id },
    data: {
      rawText: state.rawText,
      categoryKey: state.categoryKey,
      slots: state.slots as never,
      askedSlots: state.askedSlots,
      turns: state.turns as never,
    },
  });
}

export async function setCategory(row: DraftRow, categoryKey: string) {
  const schema = getCategory(categoryKey);
  if (!schema) throw new Error('Unknown category');

  const locations = await locationHints();
  let state: DraftState = { ...toState(row), categoryKey: schema.key };
  // Re-run extraction now that the category — and so the slot set — is known.
  const extraction = await extractWithLlm(state.rawText, schema, { locations }, getLlmProvider());
  state = mergeExtracted(schema, state, extraction.slots);

  const saved = await persist(row.id, state);
  return buildView(saved, state, extraction.source);
}

export async function answerSlot(row: DraftRow, slotKey: string, answer: AnswerInput) {
  const schema = getCategory(row.categoryKey);
  if (!schema) throw new Error('Draft has no category yet');

  let state = applyAnswer(schema, toState(row), slotKey, answer);
  state = addTurn(
    state,
    { role: 'USER', text: describeAnswer(schema, slotKey, answer), slotKey },
    new Date().toISOString(),
  );

  const saved = await persist(row.id, state);
  return buildView(saved, state);
}

/** Free text answering the current question, or extra information (§12). */
export async function addMessage(row: DraftRow, text: string, slotKey?: string) {
  const schema = getCategory(row.categoryKey);
  if (!schema) throw new Error('Draft has no category yet');

  const locations = await locationHints();
  let state = toState(row);
  state = addTurn(state, { role: 'USER', text, slotKey }, new Date().toISOString());
  state = { ...state, rawText: `${state.rawText}\n${text}`.trim() };

  const extraction = await extractWithLlm(text, schema, { locations }, getLlmProvider());
  state = mergeExtracted(schema, state, extraction.slots);

  const target = slotKey ? schema.slots.find((s) => s.key === slotKey) : null;
  if (target && state.slots[target.key] === undefined) {
    if (target.type === 'text' || target.type === 'date' || target.type === 'number') {
      // Free-typed answers are kept verbatim rather than dropped: "yesterday" in
      // answer to "which day was this?" is the student's answer even when no
      // extractor can turn it into an ISO date.
      const value = target.type === 'number' && Number.isFinite(Number(text)) ? Number(text) : text;
      state = applyAnswer(schema, state, target.key, { kind: 'VALUE', value });
    } else {
      // Nothing extractable came back — do not re-ask the same question forever.
      state = markAsked(state, target.key);
    }
  }

  const saved = await persist(row.id, state);
  return buildView(saved, state, extraction.source);
}

export async function editSlot(row: DraftRow, slotKey: string) {
  const schema = getCategory(row.categoryKey);
  if (!schema) throw new Error('Draft has no category yet');

  const state = clearAnswer(schema, toState(row), slotKey);
  const saved = await persist(row.id, state);
  return buildView(saved, state);
}

function describeAnswer(schema: CategorySchema, slotKey: string, answer: AnswerInput): string {
  if (answer.kind === 'SKIP') return 'Skipped';
  if (answer.kind === 'UNSURE') return "I'm not sure";
  const slot = schema.slots.find((s) => s.key === slotKey);
  const values = Array.isArray(answer.value) ? answer.value : [answer.value];
  return values
    .map((v) => slot?.options?.find((o) => o.value === v)?.label ?? String(v))
    .join(', ');
}

export async function buildView(
  row: DraftRow,
  stateInput?: DraftState,
  extractionSource?: 'RULES' | 'LLM',
): Promise<DraftView> {
  const state = stateInput ?? toState(row);
  const schema = getCategory(state.categoryKey);
  const step = nextStep(schema, state);

  const locationId = locationIdOf(state.slots);
  const location = locationId
    ? await prisma.location.findUnique({ where: { id: locationId } })
    : null;

  const summary = schema ? summaryLines(schema, state.slots, location?.name) : [];

  // Only the summary step needs it, and it costs three queries — so it is not
  // computed on every question.
  const assessment =
    schema && step.kind === 'SUMMARY'
      ? studentFacingAssessment(await assessComplaint(schema, state.slots, { locationId }))
      : null;

  return {
    id: row.id,
    rawText: state.rawText,
    categoryKey: schema?.key ?? null,
    categoryLabel: schema?.label ?? null,
    turns: state.turns,
    step:
      step.kind === 'CATEGORY'
        ? {
            kind: 'CATEGORY',
            categories: CATEGORY_SCHEMAS.map((c) => ({
              key: c.key,
              label: c.label,
              description: c.description,
            })),
          }
        : step.kind === 'QUESTION'
          ? {
              kind: 'QUESTION',
              slotKey: step.slot.key,
              question: step.slot.question,
              type: step.slot.type,
              options: step.slot.options ?? [],
              allowUnsure: step.slot.allowUnsure ?? true,
              allowSkip: step.slot.allowSkip ?? step.slot.importance !== 'REQUIRED',
              safetyCritical: Boolean(step.slot.safetyCritical),
              placeholder: step.slot.placeholder,
            }
          : {
              kind: 'SUMMARY',
              reason: step.completeness.reason,
              safetyShortCircuit: step.completeness.safetyShortCircuit,
              assessment,
            },
    summary,
    askedCount: state.askedSlots.length,
    canSubmit: step.kind === 'SUMMARY',
    complaintId: row.complaintId,
    // Which extractor produced this step's pre-fills. Not persisted — it only
    // describes the turn that just happened.
    extractionSource: extractionSource ?? null,
  };
}

export function locationIdOf(slots: SlotValues): string | null {
  const entry = slots['location'];
  if (!entry || entry.state !== 'FILLED' || typeof entry.value !== 'string') return null;
  return entry.value;
}
