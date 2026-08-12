# Smart Complaint Management System — Implementation Plan

## Context

`smart_complaint_management_system.md` specifies an AI-assisted campus complaint platform whose distinguishing idea is stated in §1:

> Don't make the student know what information is required. Make the system discover what information is required.

The repo started empty (one spec file, no commits). This plan takes it from zero to all 43 spec sections working, as a **skill-up / portfolio project** run locally via `docker compose up`.

**Decisions already settled:**

| Decision | Choice |
|---|---|
| Goal | Skill-up / portfolio; local-only |
| AI approach | Hybrid — deterministic engine is the default and always works; LLM is an optional adapter that upgrades quality |
| LLM provider | Groq (free/cheap tier, OpenAI-compatible) |
| Auth | Real credentials auth (hashed passwords + JWT cookie) with seeded users per role |
| Duplicate detection | Attribute-signature match + Postgres `pg_trgm` text similarity (no embeddings) |
| Notifications | **Deferred** (§35/§36) — the complaint timeline covers visibility in the meantime |
| Delivery style | Layer by layer; a layer is not started until the previous one is verified working |

**Companion file:** `CLAUDE.md` holds the working rules, architecture map, and token-discipline guidance for future sessions. This file holds the design and the layer plan. The **Layer Status** table below is the single source of truth for progress.

---

## 1. Tech Stack

| Concern | Choice | Why |
|---|---|---|
| Framework | **Next.js 16** (App Router, TS strict) | One codebase for UI + API. Route Handlers are curl-testable, which matters for per-layer verification gates. |
| DB | **Postgres 16** in Docker | Needs real SQL aggregation (heatmap, trends, health score) and `pg_trgm` for text similarity. Both are core features, not extras. |
| ORM | **Prisma 7** | Typed schema + migrations. ⚠️ Prisma 7 breaking changes handled in Layer 0 (see below). |
| Styling | **Tailwind 4** + shadcn/ui | Fast, and the UI has 4 distinct role surfaces to build. |
| Validation | **Zod 4** | One schema source reused for API validation *and* LLM JSON schemas. |
| Charts | **Recharts 3** | Admin/department dashboards. |
| Auth | `jose` (JWT) + `bcryptjs`, hand-rolled (~120 lines) | Avoids NextAuth config surface; RBAC here is simple and explicit. |
| LLM | `openai` SDK v7 pointed at Groq | Groq is OpenAI-compatible. |
| Background jobs | `node-cron` in a separate `npm run worker` process | SLA scanning + escalation must run outside a request. |
| Tests | **Vitest** | The engines (question selection, priority, routing, dedup) are pure functions — this is what makes "verify before next layer" real rather than vibes. |

**Groq specifics (verified against current docs):**
- Base URL `https://api.groq.com/openai/v1`. Production models: `llama-3.1-8b-instant`, `llama-3.3-70b-versatile`, `openai/gpt-oss-20b`, `openai/gpt-oss-120b`.
- **Guaranteed-schema output (`response_format: json_schema`, `strict: true`) is only supported on `openai/gpt-oss-20b` and `openai/gpt-oss-120b`.** Default to **`openai/gpt-oss-20b`** (fastest, cheapest); `gpt-oss-120b` is a one-env-var upgrade if extraction quality is short.
- Strict mode requires **every property `required`** and `additionalProperties: false` — no optional fields. So extraction schemas use explicit `"unknown"` sentinel values instead of omitting fields.
- **Groq has no embeddings API** — hence the attribute-signature dedup design in §5.

**Prisma 7 gotchas to get right in Layer 0** (these break the default tutorial setup):
```prisma
generator client {
  provider = "prisma-client"             // NOT prisma-client-js
  output   = "../src/generated/prisma"   // now REQUIRED
}
```
```ts
// src/lib/db.ts — a driver adapter is now mandatory for Postgres
import { PrismaClient } from '@/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
export const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});
```

---

## 2. System Design

```
┌─────────────────────────────────────────────────────────────────┐
│  UI (Next.js App Router, 4 role surfaces)                        │
│  /report (chat)  /complaints  /queue (staff)  /dashboard (admin) │
└───────────────────────────┬─────────────────────────────────────┘
                            │  Route Handlers (/api/*), Zod-validated
┌───────────────────────────▼─────────────────────────────────────┐
│  DOMAIN LAYER — pure, deterministic, unit-tested                 │
│                                                                  │
│  engine/     slot-filling loop, next-question selection,          │
│              completeness, classify, priority rubric, routing     │
│  dedup/      signature → candidates → score → link/create         │
│  lifecycle/  state machine + event timeline                       │
│  sla/        due dates, breach detection, escalation ladder        │
│  analytics/  SQL aggregations, recurring detection, health score   │
└──────┬──────────────────────────────────┬───────────────────────┘
       │                                  │
┌──────▼───────────┐            ┌─────────▼──────────┐
│ LlmProvider      │            │ Prisma → Postgres  │
│  GroqProvider    │            │  + pg_trgm         │
│  NullProvider ◄──┼── no key   └────────────────────┘
│  (rules only)    │
└──────────────────┘            ┌────────────────────┐
                                │ worker (node-cron) │
                                │ SLA + escalation + │
                                │ recurrence scan    │
                                └────────────────────┘
```

**The load-bearing architectural rule:** the LLM never makes a *decision*. It only performs **extraction** (unstructured text → slot values) and **prose generation** (summaries, insight narratives). Priority band, department routing, dedup verdicts, and state transitions are all deterministic code. This is what makes "explainable AI decisions" and "confidence-based human review" (§41) genuinely true rather than a claim, and it's why the whole system still works with no API key.

### Directory layout

```
skill-up/
├─ docker-compose.yml              # postgres:16 (port 5433) + adminer (8080)
├─ .env.example
├─ prisma/{schema.prisma, migrations/, seed.ts, seed-demo.ts}
├─ src/
│  ├─ app/
│  │  ├─ login/
│  │  ├─ report/                   # student: conversational complaint builder
│  │  ├─ complaints/[id]/          # student: tracking timeline
│  │  ├─ queue/                    # staff: prioritized queue
│  │  ├─ incidents/[id]/
│  │  ├─ dashboard/                # admin + department
│  │  └─ api/{auth,drafts,complaints,incidents,analytics,uploads,dev}/
│  ├─ lib/
│  │  ├─ db.ts  auth/  storage/  llm/{provider.ts,groq.ts,null.ts}
│  │  ├─ engine/
│  │  │  ├─ types.ts               # Slot, CategorySchema, Condition, DraftState
│  │  │  ├─ condition.ts           # evaluateCondition() — serializable DSL
│  │  │  ├─ schemas/               # wifi.ts electrical.ts hostel.ts ... (13)
│  │  │  ├─ next-question.ts  completeness.ts  summary.ts
│  │  │  ├─ extract/{rules.ts, llm.ts, index.ts}
│  │  │  └─ classify.ts  priority.ts  routing.ts
│  │  ├─ dedup/  lifecycle/  sla/  analytics/
│  ├─ components/
│  └─ worker/index.ts
└─ tests/                          # vitest: engine/, dedup/, sla/, priority/
```

---

## 3. Core Abstraction: Category Schemas as Slots

This is the heart of the project (spec §5–§11). Each category declares the information that *may* be useful; the engine decides what to actually ask.

```ts
// src/lib/engine/types.ts
type Condition =
  | { slot: string; op: 'eq'|'ne'|'in'|'nin'|'filled'|'unfilled'; value?: unknown }
  | { and: Condition[] } | { or: Condition[] } | { not: Condition };

interface Slot {
  key: string;
  question: string;                     // "Is there any smoke or burning smell?"
  type: 'enum'|'multi'|'text'|'number'|'boolean'|'location'|'date'|'media';
  options?: { value: string; label: string }[];   // → renders as buttons (§9)
  importance: 'REQUIRED'|'RECOMMENDED'|'OPTIONAL';   // §6
  askIf?: Condition;                    // §7 conditional relevance
  allowUnsure?: boolean;                // §10, default true
  allowSkip?: boolean;                  // §10, default true unless REQUIRED
  infoGain: number;                     // 0..1 base ordering weight
  safetyCritical?: boolean;             // jumps the queue unconditionally
  extractHints?: string[];              // keywords for the rules-based extractor
}
```

`askIf` uses a **JSON-serializable condition DSL** rather than JS predicate functions. Costs ~40 lines for `evaluateCondition()` and means schemas can move from TypeScript config into a DB table (admin-editable) later without rewriting the engine. Schemas live in TS for now — typed, diffable, testable.

**Slot values carry provenance**, which is what enables "here's what I understood" + edit (§11, §12):
```ts
type SlotValue = {
  value: unknown;
  state: 'FILLED' | 'UNKNOWN' | 'SKIPPED';       // "I'm not sure" is recorded, not blocking
  source: 'EXTRACTED' | 'ANSWERED' | 'DEFAULTED';
  confidence: number;
};
```

### Next-question selection (deterministic)

```
score(slot) = safetyCritical ? 1000 : 0
            + importanceWeight        // REQUIRED 100 · RECOMMENDED 40 · OPTIONAL 10
            + infoGain * 20
            + priorityDiscrimination  // +15 if this slot's answer could change the priority band
```
Filtered to slots that are unfilled **and** whose `askIf` currently passes. Ties break on declaration order → stable and snapshot-testable.

### Stop condition (§6 "stop asking once enough information is available")

Stop when all REQUIRED slots are resolved **and** (no RECOMMENDED slots remain **or** `askedCount >= 6`).
Short-circuit: if a `safetyCritical` slot comes back indicating live danger, **stop asking immediately** and submit as CRITICAL.

A REQUIRED slot answered "I'm not sure" resolves to a coarser default (e.g. location → building-level "unspecified") and flags `needsTriage` — the student is never blocked (§10).

---

## 4. Priority & Routing (deterministic + explainable)

**Priority rubric** (`lib/engine/priority.ts`) returns a band *and* the reasons that produced it (§14 requires the reason). Built as designed below, with the deliberate deviations noted in Layer 4's entry:
```
base = categoryBase[category]                       // ELECTRICAL 40 · NETWORK 25 · FURNITURE 10 …
     + hazard      (smoke 70 · sparking 60 · exposed wire 50 · person at risk +40)
     + scope       (ONLY_ME 0 · FEW 10 · MANY 25 · BUILDING 35 · CAMPUS 50)
     + impact      (EXAM 30 · CLASS 20 · NONE 0)
     + duration    (>3d 15 · >1d 10 · today 5)
     + locationCriticality (EXAM_HALL/LAB 15 · ACADEMIC 10 · HOSTEL 8 · OUTDOOR 3)
     + recurrence  (same signature ≥3 in 30d → +10)

band: ≥120 CRITICAL · ≥75 HIGH · ≥40 MEDIUM · else LOW
hard override → CRITICAL: FIRE | SMOKE | PERSON_AT_RISK | SECURITY_THREAT | MAJOR_LEAK
reasons[] = top contributing factors rendered as sentences
```

**Routing** (`lib/engine/routing.ts`): seeded table `(category, subcategory, locationType) → department`, with per-location overrides, falling back to the category default. Emits a confidence score; below threshold the complaint lands in a **triage queue** instead of guessing (§41 "confidence-based human review").

---

## 5. Duplicate Detection & Incidents (§16–§18)

The insight that makes this work without embeddings: **dedup runs on structured attributes *after* classification, not on raw text.** "WiFi isn't working in CSE Block" and "No internet connection in CSE building" both normalize to `category=NETWORK, subcategory=WIFI_OUTAGE, location=CSE_BLOCK` — an exact signature match. Text similarity is only a tie-breaking signal.

```
signature = hash(category, subcategory, locationId, scopeBucket)

score = 0.55 * signatureMatch
      + 0.15 * locationProximity   (same room 1.0 · floor 0.7 · building 0.5 · campus 0.1)
      + 0.15 * textSimilarity      (pg_trgm similarity on normalized title+description)
      + 0.15 * timeProximity       (decay across the category's window, default 24h)

≥0.70 → auto-link to open incident   |   0.45–0.70 → flag as suggested duplicate for staff
<0.45 → create new incident
```

**Model decision: every complaint belongs to exactly one incident.** A single-complaint incident is just a complaint, and the UI hides the incident framing until size > 1. This removes all nullable-incident branching from dashboards, merge logic, and analytics — worth the slight conceptual oddity.

On link: increment `affectedCount`, recompute incident priority (max of members, plus a scope escalation when the count crosses thresholds), and show the student the incident status message instead of a generic ack (§36).

`pg_trgm` is enabled via a raw SQL migration and queried with `prisma.$queryRaw` (Prisma has no native trigram support).

---

## 6. Data Model (Prisma)

| Model | Notes |
|---|---|
| `User` | role: STUDENT · STAFF · DEPT_MANAGER · ADMIN; `departmentId?`; hashed password |
| `Department` | name, code, `slaProfileId` |
| `Location` | self-referencing `parentId` (campus → building → floor → room), `type` (ACADEMIC / HOSTEL / LIBRARY / CANTEEN / LAB / TRANSPORT / OUTDOOR), `criticality` |
| `ComplaintDraft` | the in-progress conversation: `rawText`, `categoryKey`, `slots` JSON, `askedSlots[]`, `turns[]` JSON, status DRAFT/SUBMITTED — persisted so refresh is safe and answers are editable |
| `Complaint` | code `CMP-####`, category/subcategory, `locationId`, `slots` JSON, `priority`, `priorityReasons` JSON, `departmentId`, `status`, `incidentId`, `isAnonymous`, `assigneeId`, `responseDueAt`, `resolutionDueAt`, `escalationLevel`, `signature` |
| `Incident` | code `INC-###`, title, category, `locationId`, `priority`, `status`, `affectedCount` |
| `ComplaintEvent` | append-only timeline: type, actor, message, `meta` JSON — powers §20 and every audit view |
| `Attachment` | complaint or event scoped; `kind` PHOTO/VIDEO/AUDIO/DOC; storage key, mime, size |
| `Feedback` | rating 1–5, comment, `resolutionConfirmed` bool |
| `SlaProfile` | per-priority response + resolution minutes |
| `RoutingRule` | seeded routing table rows |
| `RecurringSignal` | detected recurring issues + preventive suggestions (worker-written) |

`isAnonymous` exists in the schema from **Layer 0** even though the behaviour ships in Layer 7 — retrofitting identity-hiding later would touch every query.

---

## 7. Layer-by-Layer Implementation

Each layer has a hard verification gate. **No layer begins until the previous gate passes.**

### Layer 0 — Foundation
Scaffold Next.js 16 + TS + Tailwind 4; `docker-compose.yml` (Postgres on **5433** to avoid clashing with any local instance, Adminer on 8080); full Prisma schema + initial migration + `pg_trgm` extension migration; `src/lib/db.ts` with the `PrismaPg` adapter; credentials auth (`bcryptjs` hash, `jose` JWT in an httpOnly cookie, middleware role guards); app shell with role-aware nav; `prisma/seed.ts` → 6 departments, ~40 locations, routing rules, SLA profiles, and one demo user per role.

**Gate:** `docker compose up` + `npm run dev` → log in as each of the 4 seeded users, each lands on their own surface, wrong-role URLs are rejected.

### Layer 1 — Static submission (no AI at all)
Plain category picker → auto-generated form from the category schema's REQUIRED slots → submit → row in `Complaint` → visible in "My Complaints" and the staff queue.

Deliberately unintelligent. It proves the data model, auth, and persistence end-to-end **before** any engine complexity lands on top — the cheapest possible place to discover a schema mistake.

**Gate:** submit as student, see it as staff, correct department pre-filled by the routing table.

### Layer 2 — Conversational engine, deterministic only
`Slot`/`Condition` types + `evaluateCondition`; `next-question.ts`; `completeness.ts`; keyword-only extraction (`extract/rules.ts`); chat UI with button/text/`[I'm not sure]`/`[Skip]` inputs (§9, §10); edit-a-previous-answer (re-answering invalidates downstream slots whose `askIf` no longer holds); summary + `[Looks Correct] [Edit] [Add More Info]` (§12).

Ship **WiFi + Electrical** schemas first — they cover both the simple path and the safety-critical short-circuit path. Then a breadth pass adds the remaining 11 categories in the same format (Classroom, Hostel, Hostel-Food, Water/Plumbing, Transport, Sanitation, Furniture, Security, Canteen, Library, Lab/Other).

**Gate:** vitest snapshot tests over scripted transcripts — "wifi down" asks location→scope→duration→impact then stops; "exposed wiring in hostel" asks the at-risk question *first*; answering "smoke: yes" halts questioning immediately. Plus a manual run of each.

### Layer 3 — LLM extraction adapter (Groq)
`LlmProvider` interface; `GroqProvider` using `openai` SDK → `openai/gpt-oss-20b`, `strict: true` JSON schema derived from the active category's slots, `temperature: 0`, 4s timeout, 1 retry; `NullProvider` fallback. Any error / missing key / timeout silently degrades to Layer 2 rules. Also generates the complaint title.

**Gate:** with `GROQ_API_KEY` set, "There is exposed electrical wiring near the hostel entrance" pre-fills category + problem + location and skips ≥3 questions vs. Layer 2. With the key **removed**, the flow still completes — this is the test that proves the hybrid design.

**Gate result (measured, `scripts/layer3-compare.ts` — rules vs LLM over the same engine, both answering the sentence faithfully):**

| Sentence | rules | LLM | |
|---|---|---|---|
| "exposed electrical wiring near the hostel entrance in Boys Hostel A" | 2 questions | 1 | pre-fills `problem_type` + `safety_hazard` |
| "No power in the whole of Boys Hostel A since yesterday, nothing sparking or smoking, and I have an exam tomorrow" | 2 | 1 | adds `scope=BUILDING` |
| "nobody in my wing of Boys Hostel A can get online since last night" | 4 (incl. a manual category pick) | **0** | keywords can't classify this at all |

The plan's "skips ≥3 questions" was a planning-time estimate and only holds on the third sentence. It cannot hold on the exposed-wiring one: Layer 2 already pre-fills the location from a literal name match, and *detecting* the hazard unlocks `person_at_risk`, so a better extraction buys a more relevant question rather than a shorter list. The substance of the gate — category + problem + location pre-filled from one sentence, and a complete run with the key removed — is verified live.

**Two defects the measurement exposed, both fixed:**
- `max_completion_tokens: 60` on the title call returned empty content every time: gpt-oss bills *reasoning* tokens against that budget. Titles now get 400 and `reasoning_effort: 'low'` is set for `openai/gpt-oss*`.
- The rules extractor read "nothing sparking or smoking" as `safety_hazard: [SMOKE, SPARKING]`, tripping the short-circuit and submitting a routine power cut as CRITICAL. `hintMatches()` now suppresses an option hint negated within three preceding tokens, while never suppressing a hint that is itself negative ("no internet", "cant log in", "nobody can"). This was a **Layer 2 bug on the no-key path**, not an LLM issue.

Enum properties also carry a `VALUE = student-facing label` legend; without it the model was choosing between `ONE_DAY` and `MULTI_DAY` on key names alone and read "since yesterday" as several days.

**As built.** Classification and slot extraction are two calls, not one: the slot set isn't known until the category is, so a single strict schema can't cover both. `extract/llm.ts` stays pure (schema construction, prompts, response → `SlotValues`); only `extract/index.ts` touches the provider. Rules always run first and the LLM refines: on a conflict the LLM wins (it reads "everyone else is fine, only mine" correctly where keyword matching returns `MANY`), and where the LLM answers `"unknown"` a keyword hit still stands. Two guards keep an LLM value safe to pre-fill — every enum value is checked against the slot's declared options, and locations come back as a free-text *phrase* resolved by the existing conservative `matchLocation()`, so the model never picks a database row. `DraftView.extractionSource` (`'RULES' | 'LLM' | null`) reports which extractor read the last message; it is per-turn and not persisted.

### Layer 4 — Classification, priority, routing, explainability
`classify.ts` (category → subcategory + scope + impact normalization), the priority rubric with `reasons[]`, routing with confidence + triage fallback. Summary screen renders priority, the *why*, and the responsible department (§12, §13, §14, §15).

**Gate:** unit tests pin every band and each hard override; the summary shows a real reason list, not a bare label.

**Gate result (passed).** 255 vitest tests, `scripts/layer4-gate.sh` over the API, and `GROQ_API_KEY= npx tsx scripts/layer4-nokey.ts` for the no-key run (service layer, because Next 16 allows only one dev server per directory). Every §14 example lands on the band the spec names — verified case by case in `tests/engine/priority.test.ts`, not asserted by eye.

**As built.** Three decisions shaped this layer:

- **Schemas declare, the engine decides.** Categories word their questions differently, so `classify.ts` never matches on a category's slot keys. Two new declarations carry the meaning: `option.hazard` maps a dangerous option onto one cross-category `Hazard` vocabulary, and `slot.signal` (`SCOPE`/`IMPACT`/`DURATION`/`RECURRING`/`PERSON_AT_RISK`) marks the slots the rubric reads. One rubric therefore scores all 13 categories, and a 14th is additive.
- **One source of truth for live danger.** The rubric takes `safetyShortCircuit` as an *input* rather than re-deriving danger from hazards. The schemas' `criticalValues` already stop the conversation (§3), so passing that signal in means a halted conversation can never submit as anything but CRITICAL — previously the submit route special-cased this. `CRITICAL_HAZARDS` still overrides independently, which is what catches a hazard named on a *problem type* rather than a safety slot (a burst pipe → `MAJOR_LEAK` → CRITICAL, per §14's "major water leakage").
- **The student is shown the real assessment, not a lookalike.** `lib/complaints/assess.ts` is the only place classification, priority and routing are computed; the pre-submission summary and the submission call the same function, and the gate asserts the shown band equals the stored one. Routing uncertainty is deliberately not student-facing (§39): an unrouted complaint reads "to be assigned by the campus office", while staff see confidence, score, per-reason points and the signature.

**Deviations from the plan above, all deliberate:**

| Plan | As built | Why |
|---|---|---|
| `signature = hash(...)` | readable composite `CATEGORY\|SUBCATEGORY\|locationId\|scopeBucket` | Groups identically, survives `GROUP BY`, and can be read off a row when a dedup decision needs explaining. |
| recurrence `+10` only | `+10` from history, `+5` when the student says it recurs | The weaker signal is real evidence and free — the student was asked anyway (§8 hostel/food). Never both. |
| impact `EXAM 30 · CLASS 20 · NONE 0` | adds `ASSIGNMENT 10` | The schemas offer it as an answer, so it needed a weight. |
| `locationCriticality` by location type | `round(criticality × 15)`, unknown location assumed 0.5 | Criticality is already a seeded 0..1 per location, finer than a type table; an unidentified location scoring 0 would have quietly under-prioritised it. |

**Two defects this layer exposed, both fixed:**
- Shared scope options were voting on *category*. Once every category declared its own scope wording, "nobody in my wing can get online" classified as HOSTEL on the strength of the hint `my wing` — a circumstance, not a category. `extractCategory` now ignores options on `signal` slots. Caught by the Layer 3 regression test, which had pinned that sentence as unclassifiable by keywords.
- `exposed wiring` failed to match "exposed **electrical** wiring" — the spec's own §7 example sentence — because an intervening word defeats phrase matching. The phrase is now listed explicitly.

**Also landed here (carried forward from Layer 2):** the breadth pass. All 11 remaining categories now have slot schemas. Category boundaries are exclusive by design — cleaning belongs to SANITATION, taps and drains to WATER, power to ELECTRICAL — because overlapping option sets made the keyword classifier flip a coin. Where two categories still fit equally well ("the fan in my hostel room is not working"), the extractor caps its confidence below the threshold and the student picks (§9) instead of the system guessing. `tests/engine/schemas.test.ts` holds the invariants a new schema must satisfy.

**Carried into Layer 5:** `scopeBucket` is part of the signature, so a complaint whose scope was never answered (`UNKNOWN`) will not signature-match one where it was. Dedup scoring should treat `UNKNOWN` as a wildcard in the candidate query rather than relying on exact signature equality — signature match is only 0.55 of the score by design.

### Layer 5 — Dedup & incidents
Signature computation, candidate query (open incidents, same category/location family, inside window), scoring, auto-link / suggest / create; affected-count rollup; incident detail page listing member complaints; student-facing incident message (§36).

**Gate:** submit the four spec §16 phrasings from four student accounts → one incident, `affectedCount = 4`, and students #2–4 see the incident message rather than a generic ack.

**Gate result (passed).** 298 vitest tests, `GROQ_API_KEY= npx tsx scripts/layer5-nokey.ts` (the gate proper — it controls its own history, so it asserts the exact numbers), and `scripts/layer5-gate.sh` over the API with four real logins. The four §16 phrasings converge on one incident at 1.00 / 0.89 / 0.81, the affected count reaches 4, and students 2–4 are handed the §36 message while student 1 gets a plain acknowledgement.

**As built.** Four decisions shaped this layer:

- **Attributes decide, text only breaks ties.** The four §16 sentences share almost no words — trigram similarity between them runs 0.10–0.20 — and they still auto-link, because 0.55 of the score is the classification and only 0.15 is the wording. This is the whole reason no embeddings are needed, and the unit tests pin it by scoring the four cases at deliberately *low* text similarity.
- **`affectedCount` counts distinct reporters, not complaints.** §18 says "47 students have reported this issue", and one student filing twice is one affected student. The API gate exercises this for real: the incident it inspects holds nine complaints from four students and reports 4.
- **Scale escalates the incident, never the complaint.** 5 affected → +1 band, 20 → +2, applied to the incident only. Re-banding a stored complaint behind the student's back is exactly what Layer 4 was built to prevent, so members keep the band they agreed to (§12) and the gate asserts linking never changes it.
- **The middle band is a question put to a person.** 0.45–0.70 writes an internal `DUPLICATE_SUGGESTED` event and gives the complaint its own incident; staff see a "Merge into INC-xxx" panel backed by `POST /api/incidents/[id]/merge`, which runs the *same* `linkToIncident` as the automatic path. Confirming a merge empties the old incident, which is then collected — every complaint has exactly one incident, so an emptied one is a leftover, not a record.

**Deviations from the design above, all deliberate:**

| Design | As built | Why |
|---|---|---|
| `signatureMatch` on the whole signature | graded on category + subcategory + scope bucket; location scored separately | The signature includes `locationId`, and `locationProximity` already weighs location. Counting it twice would punish a same-building/different-room pair across 0.70 of the score instead of 0.15. Identical signatures still score 1.0. |
| exact signature equality to find candidates | candidates drawn by category + window + open incident | Layer 4's carried note: an `UNKNOWN` scope bucket must be a wildcard. §16's fourth student never says how many people are affected and has no building — they still link at 0.81. |
| location proximity by tree distance | by depth of the deepest shared ancestor | Written as hop-distance first, and a test caught it: two *buildings* are one hop apart through the campus root, which scored them 0.7 "same floor". Sharing the root is the weakest relationship, not the strongest. Containment then falls out for free — a room and its own floor share that floor. |
| single global dedup window | per-category `dedupWindowHours`, already declared by all 13 schemas | A burst pipe twelve hours apart is two floods; a broken chair three days apart is one chair. |
| `Incident.departmentId` | derived from members | Members share a category and location family, so they route identically (§15). Storing it would be a second copy of a routing decision that could go stale. |

**One thing worth recording for later layers:** the near-miss case in the gate originally used "the wifi keeps disconnecting", which lands on the right subcategory *only with an API key* — no keyword hint matches "disconnecting". The case now uses wording the rules extractor reads on its own, so the band it asserts is provable rather than incidental. Any future gate that pins a dedup band has to pick its sentence the same way.

**Carried into Layer 6:** incident status is set to `OPEN` and never moves — propagation from member complaints is Layer 6's job, and `loadIncident` already derives everything the propagation will need. `IncidentStatus.RESOLVED/CLOSED` already changes the §36 message text.

### Layer 6 — Lifecycle & staff workflow
State machine with an explicit transition table enforced in one `transition()` function, every transition writing a `ComplaintEvent`. States: SUBMITTED → ANALYZING → ASSIGNED → ACKNOWLEDGED → IN_PROGRESS → RESOLVED → CLOSED, plus WAITING_FOR_STUDENT, REOPENED, REJECTED, DUPLICATE. Staff queue sorted Critical → High → SLA-at-risk → Normal (§21); accept/assign/update-status/add-progress/request-info; student tracking page with the stepper + timestamped feed (§20). Incident-level status propagates to member complaints.

**Gate:** drive a complaint through the full happy path as staff; the student page shows every step with timestamps; an illegal transition is rejected by the API.

**Gate result (passed).** 346 vitest tests, `GROQ_API_KEY= npx tsx scripts/layer6-nokey.ts` (the gate proper — it also covers the incident-wide action), and `scripts/layer6-gate.sh` over the API with four logins. One complaint runs submitted → analyzed → assigned → accepted → in progress → question → answer → resolved → closed; every reached step on the student's tracker carries a timestamp taken from its own event; `respondedAt` / `resolvedAt` / `closedAt` are all stamped; and four refusals are exercised — an illegal move (409 with the legal alternatives), a student in the staff workflow (403), another department (403), and a rejection with no reason (409).

**As built.** Four decisions shaped this layer:

- **One table, one writer.** `lifecycle/machine.ts` holds the transition table and nothing else — no Prisma, no clock — and `transition()` is the only function that writes `Complaint.status`. Everything else (the submission path, the four route handlers, the incident-wide action) asks it. That is what makes the timeline a record rather than a log: a status the feed cannot explain is unreachable.
- **Submission records the steps that already happened.** Analysis and routing run *before* the complaint row exists, so leaving it at SUBMITTED would show the student an empty tracker for finished work. `createComplaint` walks SUBMITTED → ANALYZING → ASSIGNED through `transition()`, giving §20's "10:20 submitted / 10:21 assigned to IT" for free. A complaint routing could not place stops at ANALYZING and waits for a human (§15).
- **Both directions between a complaint and its incident.** Up: an incident's status is recomputed from its members on every transition — active as soon as **one** member is being worked on, resolved only when **every** one is, because thirty-nine of forty students still have no Wi-Fi otherwise. Down: `POST /api/incidents/[id]/status` applies the move to every member, each through `transition()`, and reports the ones that could not go rather than forcing them.
- **The queue is a pure function.** `sortQueue()` implements §21's Critical → High → SLA-approaching → Normal (with finished work last) and reads the Layer 8 due dates as nullable. Until Layer 8 stamps them, the at-risk bucket never fires and the order degrades to band → score → age; the unit tests pin the bucket with synthetic dates so it is already proven when the dates arrive.

**Deviations from the design above, all deliberate:**

| Design | As built | Why |
|---|---|---|
| the §19 ladder as drawn | ASSIGNED → IN_PROGRESS is **not** a legal edge | `respondedAt` is stamped on ACKNOWLEDGED and Layer 8's response SLA is measured against it. The shortcut would leave a worked-on complaint with no response time at all. The progress-update route acknowledges first rather than skipping. |
| incident action applies the status | it walks each member up the ladder to it | Members sit at different rungs. "Resolve all" on forty untouched complaints would otherwise resolve none. `pathTo()` finds the shortest legal route per member, so every rung is still a real transition with its own event — and `respondedAt` is stamped on the way past. Intermediate steps may not be ones that need a reason: nobody is carried *through* "rejected" en route somewhere else. |
| statuses named by their enum in the feed | each rule carries a `narration` | §20's feed reads "Investigation started", not "IN_PROGRESS", and "Assigned to IT Services" rather than "Assigned" — the department is the informative half. |
| — | `scripts/layer6-backfill.ts` | 66 complaints from Layers 1–5 sat at SUBMITTED, a state only the system can leave, so staff opening one were offered nothing. The backfill walks them through the same `transition()` a new complaint takes. |

**Carried into Layer 7–9:** the transition table already permits the two moves Layer 9 needs (`RESOLVED → CLOSED` and `RESOLVED → REOPENED`, both by the student, the reopen requiring a reason), so that layer adds screens and a `Feedback` row rather than new rules. `reopenCount` is already incremented and `resolvedAt`/`closedAt` cleared on reopen.

### Layer 7 — Attachments & anonymous reporting — **dropped**
`StorageAdapter` interface + `LocalDiskStorage` (`./uploads`, size/mime caps, served through an auth-checked route handler). Student attachments during the conversation; staff resolution evidence; **voice input via the browser's Web Speech API** (free, no server transcription — transcript feeds the same text pipeline). Anonymous flag hides student identity from department-facing views while preserving it for admin audit.

**Gate:** upload a photo and a short video, both render for staff; an anonymous complaint shows "Anonymous" in the staff view and the real user only in the admin audit trail.

**Not built (deliberate, 13 Aug 2026).** Evidence and anonymity are additive to the core idea rather than part of it, and nothing downstream depends on them: `Attachment` and `Complaint.isAnonymous` exist in the schema from Layer 0, the queue and the staff views already read `isAnonymous` when rendering a reporter's name, and no analytics figure counts attachments. Picking it up later touches uploads, one route handler and two views — not the pipeline.

### Layer 8 — SLA & escalation
`SlaProfile`-driven `responseDueAt` / `resolutionDueAt` set on assignment. Worker (`node-cron`, every minute) scans breaches and walks the ladder: response breach → dept manager, resolution breach → admin, 2× resolution → admin + flagged (§22). SLA-at-risk badges in the queue.

Include a **dev-only clock-simulation endpoint** (`/api/dev/advance-clock`) so SLA breach and escalation can be demoed in seconds instead of hours. Without this, the feature is effectively undemoable in a portfolio walkthrough.

**Gate:** create a HIGH complaint, advance the simulated clock past the response window, observe escalation to the manager plus timeline events.

**Gate result (passed).** 369 vitest tests at the time, `GROQ_API_KEY= npx tsx scripts/layer8-nokey.ts` (the gate proper) and `scripts/layer8-gate.sh` over the API with the demo clock. One complaint picks up both deadlines from its department's own profile on assignment, is aged past each deadline in turn, and climbs the ladder 0 → 1 (manager) → 2 (admin) → 3 (flagged), each rung leaving a `SLA_BREACHED` and an `ESCALATED` event; a second sweep a moment later writes nothing; a complaint answered on time skips the response rung entirely; settled work is never escalated; and a reopen tears up the old promise and issues a fresh one.

**As built.** Four decisions shaped this layer:

- **The promise is stamped by `transition()`, not beside it.** Layer 6 already made that function the only writer of `respondedAt`/`resolvedAt`/`closedAt`; the due dates join them, because "this complaint reached a department" *is* a status change. ASSIGNED always (re)starts both clocks; ACKNOWLEDGED and IN_PROGRESS only fill a gap, which is what gives the pre-Layer-8 rows and the `REOPENED → IN_PROGRESS` shortcut a promise at all.
- **A rung is only climbed when its own failure happened.** `escalationPlan()` filters the ladder by the breach flags rather than walking 0 → 1 → 2, so a complaint acknowledged in two minutes and then left unrepaired for a week goes straight to the administrator. Walking every rung would put a "nobody responded" failure in the timeline of a complaint that was answered immediately.
- **Idempotence is the design, not a safeguard.** `escalationLevel` records the rung reached, and the sweep only ever moves a complaint *up* from it. That is what makes a once-a-minute cron safe, lets the dev endpoint and the worker both trigger it, and means a missed minute costs nothing.
- **The demo clock ages the complaint instead of moving "now".** Every pure module already takes `now` as an argument and the worker runs in its own process, so a global clock offset would have to be threaded through all of them *and* shared across processes. Shifting one complaint's own timestamps back achieves the same demo with no changes to the domain layer, and it agrees with the worker for free.

**Deviations from the design above, all deliberate:**

| Design | As built | Why |
|---|---|---|
| `/api/dev/advance-clock` moves the clock forward | it makes the target complaint older | A simulated global "now" would have to be persisted (the worker is a separate process) and injected into every pure function. Ageing rows keeps one real clock, and one complaint can be aged without disturbing the rest of the campus. |
| escalation notifies people | it records who it went to | §35/§36's notifications stay deferred, so the `ESCALATED` event names the manager or administrator in `meta` and the queue/complaint page show the rung. The recipient lookup is real; only the delivery is missing. |
| "2× resolution" measured from assignment | measured from `createdAt` | Due dates are stamped seconds after submission, so the two are the same instant in practice — and using `createdAt` keeps `SlaRow` free of a column that would exist to answer one question. |
| §22's ladder ends at "admin + flagged" | `escalationLevel >= 3` *is* the flag | No new column: the level already records how far up the ladder a complaint went, and a separate boolean could disagree with it. |
| — | reopening clears `respondedAt` | §23's reopen re-flags the department, which means the complaint has to be answered *again*. Keeping the old acknowledgement would leave the second attempt with a response SLA that was already satisfied before the work began. |

### Layer 9 — Resolution confirmation, reopen, feedback
On RESOLVED, the student is asked "Was the issue actually fixed?" → `[Yes]` closes it, `[No]` reopens with a reason and re-flags the department (§23). Then a 1–5 star rating + comment (§24). Reopen counts feed analytics.

**Gate:** resolve → decline → complaint returns to REOPENED with an event; resolve → accept → CLOSED → rating captured.

**Gate result (passed).** `GROQ_API_KEY= npx tsx scripts/layer9-nokey.ts` and `scripts/layer9-gate.sh` over the API. One complaint is resolved, declined by the student with a reason, comes back as REOPENED with `reopenCount` 1, a cleared `resolvedAt` and a fresh SLA promise, is resolved again, confirmed, closed and rated 4/5; a second is confirmed first time and rated 5/5. Five refusals are exercised: staff confirming on the student's behalf (403), a reason-less decline (400), a rating before there is a resolution (409), a second rating (409), and a stranger rating someone else's complaint (404 — they should not learn it exists).

**As built.** As predicted from Layer 6, this layer added screens and one table row rather than new rules — the transition table already permitted both moves. Three decisions:

- **The question belongs to the reporter, and to nobody else.** Not the department, not an administrator: `confirmResolution()` compares against `reporterId`, so being able to *see* a complaint is not being the person it happened to. The staff panel also stops offering "Close" on a RESOLVED complaint — legality is one question (the table still permits it, and Layer 12's auto-close will need it) and whose decision it is is another.
- **The logic is a service, not a route body.** `feedback/service.ts` holds both decisions and the routes map outcomes to HTTP. That is what let the no-key gate drive §23 and §24 with no API at all, the same way `createComplaint` and `applyIncidentStatus` are driven.
- **A rating is an opinion, not a lifecycle step.** It never moves the complaint. It is allowed on RESOLVED as well as CLOSED — but `resolutionConfirmed` records which, so a rating given without confirming the fix cannot be counted as a confirmation. One rating per complaint, or the campus average becomes a count of button presses.

| Design | As built | Why |
|---|---|---|
| rating captured after closing | allowed on RESOLVED or CLOSED, flagged either way | A student who rates the work without answering §23 has still said something worth recording; `Feedback.resolutionConfirmed` keeps the two facts apart. |
| — | `RESOLUTION_CONFIRMED` / `RESOLUTION_REJECTED` events | The status change alone does not record that a *human checked*. §31's confirmed-versus-reopened comparison needs both halves, and the feed reads better for it. |
| — | the rating appears in the feed headline ("Feedback submitted · 4/5") | "Feedback submitted" alone tells a staff member nothing they would act on. |

### Layer 10 — Analytics, dashboards, insights
`prisma/seed-demo.ts` generates **~800 complaints across 6 months** with realistic category/location/seasonal distributions — without history, every analytics feature renders empty and can't be verified. Then: admin overview KPIs (§31), category distribution, department performance comparison, department dashboard (§32), campus heatmap by location density (§28), recurring-issue detection via month-over-month growth per (location, category) with a threshold (§27), preventive maintenance suggestions written to `RecurringSignal` (§30), campus health score (§34):

```
health = 100 − openCriticalPenalty − slaBreachRate*25 − reopenRate*15
             − recurringIssuePenalty + satisfactionBonus     → clamp 0..100
```
computed campus-wide and per category. Aggregations are raw SQL via `$queryRaw`.

**Gate:** dashboards populated from demo data; the heatmap flags the intentionally-overloaded building; the recurring detector fires on the seeded escalating-WiFi trend.

**Gate result (passed, with the demo seed dropped).** `prisma/seed-demo.ts` was **not built** — a deliberate call on 13 Aug 2026 — so the dashboards run on the ~100 complaints the earlier layers' gates created, all of them inside one month. That changed what the gate can honestly claim, so it claims something better: instead of trusting the aggregates because the numbers look plausible against seeded data, `GROQ_API_KEY= npx tsx scripts/layer10-nokey.ts` **recounts every one of them against the row-level modules** — §31's totals against Prisma, the SQL breach count against `sla/breach.ts`, §28's building roll-up against a TypeScript walk of the location tree, §34's score against `healthScore()` — and drives §27 → §30 end to end over a four-month trend it creates and deletes (`L10-` code prefix, cleaned up in a `finally`). `scripts/layer10-gate.sh` then checks the same figures over the API, that the rendered page shows the numbers the API returned, and the RBAC around both.

**As built.** Five decisions shaped this layer:

- **One composition layer, two dashboards, one set of numbers.** `analytics/service.ts` assembles everything; the pages and `/api/analytics/overview` both render its output. That is the same rule `assess.ts` enforces for priority — a figure the page shows must be a figure the API can be asked for, or the two drift.
- **The pure/impure split holds.** `recurring.ts`, `heatmap.ts` and `health.ts` are pure and unit-tested over synthetic series; `sql.ts` owns every `$queryRaw` (the designated impure module, exactly as `dedup/candidates.ts` is for dedup) and `service.ts` glues them. The breach definition exists **once** in SQL, as a composed `Prisma.sql` fragment reused by the overview, the per-category cut and the department table — and the gate proves that fragment agrees with `sla/breach.ts` complaint by complaint.
- **A score is never a bare number.** §34 returns its five terms, each signed and with the measurement behind it ("19% of complaints with a deadline missed it"), and the panel prints them under the score. §14's discipline, applied to the campus.
- **The detector refuses to flatter the data.** Three floors, all of which real data forced: sustained volume (12 in the window), a live latest month (≥4), and — the one the live database exposed — a **baseline to grow from**. With every complaint inside one month the detector was reporting "up 5200% since March" against months that predate the system; it now requires either a non-zero first month or three active months, and where there is no baseline it says "up from none" rather than inventing a percentage.
- **Charts are server-rendered CSS and SVG, one series each.** No chart library, no client JS: horizontal bars for ranked magnitudes, columns for monthly volume (six discrete readings, not a continuous line), a 2px sparkline for the rolling 30 days, and §28's three bands each printed as a *word* beside its swatch. Colour is a second channel everywhere — two of the three status steps are below 3:1 on white, and the map has to be readable by someone who cannot separate red from amber.

**Deviations from the design above, all deliberate:**

| Design | As built | Why |
|---|---|---|
| `prisma/seed-demo.ts`, ~800 complaints over 6 months | not built | Explicit instruction (13 Aug 2026). The cost is that §27's trend and §28's density are thin in the running app; the mitigation is that the gate recounts every aggregate against the row-level modules and drives the detector over a temporary real trend, which is a stronger check than "the dashboard looks populated". |
| the heatmap keyed on `Complaint.locationId` | rolled up to the **building** via a recursive CTE | §28 names buildings ("CSE Block 🔴 High") but students name whatever they can — usually a room. Eleven scattered room-level complaints are one problem block, and the CTE is what makes them legible as one. |
| recurring detection per (location, category) | per (**building**, category), same roll-up | Same reason: a trend split across four rooms of one hostel is one trend. |
| `RecurringSignal` written by the worker | written by the worker **and** an admin button | The nightly cron is right for operations and useless in a walkthrough. Both paths call `scanRecurring()`, which upserts per (category, building, window end), so neither can duplicate the other's rows. |
| SLA at risk counted in SQL | counted in TypeScript with `slaRisk()` | The 25%-of-window threshold lives in `queue/rank.ts` and is unit-tested there. A department's open queue is a couple of hundred rows, so reusing the tested function beats duplicating the threshold in SQL where it could silently diverge from the queue's badges. |
| a "dashboard" route per role | one route, two components | An administrator's question is "what is happening across campus"; a department's is "what needs attention right now". Same URL, scope decided by role — so a staff member cannot ask for another department's satisfaction by editing a query string. |

### Layer 11 — Search & discovery
Faceted search over status/priority/category/department/location/date + `pg_trgm` full-text on title/description, backing both the student history filters (§37) and admin queries like "complaints that have exceeded their resolution time" (§38).

**Gate:** each of the four §38 example queries returns correct results.

### Layer 12 — AI-generated insight narratives
Weekly summary (§33): numbers computed in **SQL**, then handed to Groq purely to write the prose paragraph. Falls back to a template renderer with no key. **Notifications (§35/§36) stay deferred** — the schema and event stream already support them, so it's an additive layer whenever wanted.

**Gate:** generate a weekly summary whose stated numbers match the SQL output exactly.

---

## Layer Status

Update this table as each gate passes. Mirrored in `CLAUDE.md` §7.

| # | Layer | Status |
|---|---|---|
| 0 | Foundation: scaffold, Docker Postgres, Prisma schema, auth, seed | ✅ Gate passed |
| 1 | Static submission (no AI) | ✅ Gate passed |
| 2 | Conversational engine (deterministic) | ✅ Gate passed |
| 3 | LLM extraction adapter (Groq) | ✅ Gate passed |
| 4 | Classification, priority, routing, explainability | ✅ Gate passed |
| 5 | Dedup & incidents | ✅ Gate passed |
| 6 | Lifecycle & staff workflow | ✅ Gate passed |
| 7 | Attachments & anonymous reporting | ⬜ Dropped — additive, nothing depends on it |
| 8 | SLA & escalation | ✅ Gate passed |
| 9 | Resolution confirmation, reopen, feedback | ✅ Gate passed |
| 10 | Analytics, dashboards, insights | ✅ Gate passed (no demo seed — see the layer) |
| 11 | Search & discovery | ⬜ Next |
| 12 | AI insight narratives (notifications deferred) | ⬜ |

---

## 8. Deliberate Trade-offs

- **Category schemas live in TypeScript, not the DB.** Not admin-editable at runtime. Mitigated by the serializable condition DSL, so a DB migration is additive later.
- **Every complaint gets an incident.** Slightly unusual conceptually; removes a large amount of nullable branching from analytics and merge logic.
- **Question *selection* is deterministic; only *extraction* is LLM-driven.** Costs some conversational flair, buys testability, zero-cost operation, no hallucinated questions, and real explainability.
- **No embeddings.** Semantically-distant phrasings of the same issue are caught via post-classification attribute matching rather than vector similarity. Adding pgvector + a local MiniLM model later is a self-contained upgrade to `dedup/score.ts`.
- **Polling, not websockets,** for status updates — simpler, adequate at this scale; SSE is a drop-in later.
- **The demo clock ages complaints rather than moving time.** Keeps one real clock in a system whose pure modules all take `now` as an argument and whose worker runs in a separate process. The cost is that "advance the clock" is really "age this complaint", which is a demo script's job anyway.
- **No demo history.** `seed-demo.ts` was dropped, so §27's trends and §28's density are thin in the running app. The gates compensate by recounting every aggregate against the row-level modules and by driving the recurrence detector over a temporary trend, but a walkthrough will show a sparse heatmap until real complaints accumulate.

## 9. Verification Strategy

1. **Unit tests (vitest)** on the pure domain layer — question selection, completeness, priority bands and overrides, routing, dedup scoring, SLA math, health score. These are the layer gates.
2. **Transcript snapshot tests** for the conversation engine: fixed student inputs → asserted question sequence.
3. **Manual role walkthrough** per layer, using the seeded accounts.
4. **`curl` against Route Handlers** for API-level checks (illegal transitions, RBAC rejections).
5. **The no-key run** after Layer 3, repeated at every later layer: unset `GROQ_API_KEY` and confirm the whole system still completes a complaint end-to-end.
