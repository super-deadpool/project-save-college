# Smart Complaint Management System — How It Works

A technical walkthrough for someone who has just opened this repository: what the
system does, how it is built, what algorithms it runs, and — in the most detail —
what the AI actually does and, just as importantly, what it is not allowed to do.

- Setup and commands → [`README.md`](README.md)
- The layer-by-layer plan and every design decision with its reasoning → [`plan.MD`](plan.MD)
- Working rules for anyone changing the code → [`CLAUDE.md`](CLAUDE.md)

---

## Table of contents

1. [The problem, and the one idea](#1-the-problem-and-the-one-idea)
2. [The load-bearing rule: the LLM never decides](#2-the-load-bearing-rule-the-llm-never-decides)
3. [Feature map](#3-feature-map)
4. [System design](#4-system-design)
5. [The conversation engine](#5-the-conversation-engine)
6. [The AI part, in detail](#6-the-ai-part-in-detail)
7. [Classification: turning answers into facts](#7-classification-turning-answers-into-facts)
8. [Priority: the rubric](#8-priority-the-rubric)
9. [Routing](#9-routing)
10. [Duplicate detection and incidents](#10-duplicate-detection-and-incidents)
11. [Lifecycle](#11-lifecycle)
12. [SLA and escalation](#12-sla-and-escalation)
13. [Queue ranking](#13-queue-ranking)
14. [Resolution, reopen, feedback](#14-resolution-reopen-feedback)
15. [Analytics](#15-analytics)
16. [Data model](#16-data-model)
17. [API surface](#17-api-surface)
18. [How it is verified](#18-how-it-is-verified)
19. [Trade-offs, and what is deliberately not built](#19-trade-offs-and-what-is-deliberately-not-built)
20. [Where to start reading](#20-where-to-start-reading)

---

## 1. The problem, and the one idea

A campus complaint form asks a student to know things they don't know: which
department owns the problem, how urgent it is, what details matter. Most people
type "wifi not working" and leave, and the ticket is useless.

The spec's §1 states the inversion this project is built around:

> **Don't make the student know what information is required. Make the system
> discover what information is required.**

So the student writes one sentence. The system works out what category that is,
what it still needs to know, asks only those questions, shows the student what it
understood, and only then files a complaint that is classified, prioritised,
routed, deduplicated against everyone else's reports, and on an SLA clock.

Two concrete examples of what "discover" means here:

| Student types | System does |
|---|---|
| "There is exposed electrical wiring near the hostel entrance in Boys Hostel A" | Recognises ELECTRICAL, reads the hazard `EXPOSED_WIRE` and the location, then asks *"Is anyone in immediate danger?"* — a question that only exists because a hazard was found. Answering "yes" stops the conversation immediately and files as CRITICAL. |
| "nobody in my wing of Boys Hostel A can get online since last night" | Keywords cannot classify this at all ("wing", "get online"). With an LLM key it pre-fills category, subcategory, location, scope and duration and asks **zero** questions. Without a key it asks four, including a manual category pick. Both produce the same filed complaint. |

---

## 2. The load-bearing rule: the LLM never decides

This is the single most important thing to understand about the codebase.

The LLM has exactly two jobs:

| The LLM **does** | The LLM **never does** |
|---|---|
| **Extraction** — unstructured text → structured slot values | Priority band |
| **Prose** — the complaint title, and (Layer 12) insight narratives | Department routing |
| | Duplicate verdicts |
| | State transitions |
| | Which question to ask next |
| | Whether the conversation can stop |

Everything in the right column is deterministic TypeScript with unit tests. Three
things follow, and they are the reason the design is shaped this way:

1. **Explainability is real, not a claim.** A priority band arrives with the
   sentences that produced it and the points behind each one, because a pure
   function built both at the same time. Nothing has to reconstruct a rationale
   after the fact.
2. **The system works with no API key.** Every LLM call has a rules-based
   fallback, and the provider returns `null` rather than throwing. Remove
   `GROQ_API_KEY` and the whole pipeline still completes — it just asks a few more
   questions.
3. **The domain layer is testable.** `engine/`, `dedup/`, `sla/`, `feedback/` and
   `analytics/` cannot import Prisma or call `fetch`, except for one designated
   impure module each. Data in, decisions out. That is what makes 414 unit tests
   possible over what is otherwise an "AI system".

The boundary is one interface:

```ts
// src/lib/llm/provider.ts
export interface LlmProvider {
  readonly name: string;
  readonly available: boolean;                    // false ⇒ callers skip prompt building
  json<T>(request: LlmJsonRequest): Promise<T | null>;
  text(request: LlmTextRequest): Promise<string | null>;
}
```

Both methods resolve to `null` on **every** failure mode — timeout, 429, bad key,
malformed JSON, a model refusal, an empty completion. `null` means "the LLM had
nothing for you", and the caller runs the rules. No `try/catch` anywhere else in
the codebase exists for LLM reasons.

---

## 3. Feature map

| Area | What works |
|---|---|
| **Conversational intake** | One sentence → category detection → only the questions that are still needed → "here's what I understood" summary → edit any answer → submit. Buttons, free text, `[I'm not sure]` and `[Skip]` on every question. |
| **Safety short-circuit** | A hazard answer indicating live danger ends the conversation immediately and files as CRITICAL. |
| **Classification** | 13 category schemas; subcategory, scope, impact, duration, hazards, person-at-risk, recurrence, location — normalised into one cross-category vocabulary. |
| **Priority** | An additive rubric producing a band, a score, and a list of reason sentences. Hard overrides for fire/smoke/gas/shock/major-leak/flooding/security. |
| **Routing** | Table-driven, most-specific-rule-wins, with a confidence score and a triage fallback when confidence is too low to guess. |
| **Duplicate detection** | Attribute-signature scoring with `pg_trgm` text similarity as a tie-breaker. Auto-link ≥0.70, staff suggestion 0.45–0.70, new incident below. |
| **Incidents** | Every complaint has exactly one. Affected-count by *distinct reporter*, priority = worst member escalated by scale, status derived from members, staff merge, incident-wide status action. |
| **Lifecycle** | 11 states, one explicit transition table, one writer, an append-only event timeline, a student-facing stepper with real timestamps. |
| **Staff workflow** | Prioritised queue (§21 ordering), accept / start / request info / resolve / reject / mark duplicate, department-scoped RBAC. |
| **SLA** | Per-department, per-band response and resolution windows stamped on assignment; a cron sweep that walks the escalation ladder staff → manager → admin → flagged; at-risk badges; a dev clock to demo it in seconds. |
| **Resolution & feedback** | The reporter — nobody else — confirms or rejects a fix; rejection reopens with a reason and a fresh SLA promise; a 1–5 rating, once. |
| **Analytics** | Campus and department dashboards, category distribution, department comparison, building heatmap, recurring-trend detection, preventive suggestions, a campus health score that shows its five terms. Server-rendered charts, no client JS. |
| **Auth** | bcrypt + `jose` JWT in an httpOnly cookie, four roles, guards in layouts, pages and route handlers. |

Not built: attachments and anonymous reporting (dropped — additive), search
(Layer 11), AI insight narratives (Layer 12), notifications (deferred).

---

## 4. System design

```
┌──────────────────────────────────────────────────────────────────────┐
│  UI — Next.js App Router, four role surfaces                          │
│  /report (chat)   /complaints   /queue (staff)   /dashboard           │
└────────────────────────────┬─────────────────────────────────────────┘
                             │ Route Handlers (/api/*), Zod-validated
┌────────────────────────────▼─────────────────────────────────────────┐
│  DOMAIN LAYER — pure, deterministic, unit-tested                      │
│                                                                       │
│  engine/     slot filling · next question · completeness ·            │
│              classify · priority rubric · routing                     │
│  dedup/      signature → candidates → score → link / suggest / create  │
│  lifecycle/  transition table · stepper · timeline                    │
│  sla/        due dates · breach detection · escalation ladder          │
│  queue/      §21 ordering                                             │
│  feedback/   rating validity · satisfaction aggregation               │
│  analytics/  recurrence detection · heatmap · health score            │
└──────┬─────────────────────────────────────┬─────────────────────────┘
       │                                     │
┌──────▼────────────┐              ┌─────────▼──────────┐   ┌──────────────────┐
│ LlmProvider       │              │ Prisma → Postgres  │   │ worker (node-cron)│
│  GroqProvider     │              │  + pg_trgm         │   │ SLA sweep / min   │
│  NullProvider ◄───┼── no key     └────────────────────┘   │ recurrence nightly│
└───────────────────┘                                        └──────────────────┘
```

**The pure/impure split is enforced per area.** Each domain area has exactly one
module allowed to touch the database:

| Area | Pure modules | The one impure module |
|---|---|---|
| dedup | `score.ts` | `candidates.ts` (the `pg_trgm` `$queryRaw`) |
| sla | `due.ts`, `breach.ts` | `service.ts` |
| analytics | `recurring.ts`, `heatmap.ts`, `health.ts`, `format.ts` | `sql.ts` (+ `service.ts`, which only composes) |
| lifecycle | `machine.ts`, `stepper.ts`, `timeline.ts` | `transition.ts` |
| engine | everything | — (callers pass data in) |

This is not stylistic. A threshold that lives inside a service function cannot be
unit-tested, and every layer's verification gate is a unit test plus one script.

### Two rules about single sources of truth

**One assessor.** `complaints/assess.ts` is the *only* place classification,
priority and routing are computed. The pre-submission summary calls it and the
submission calls it, which is what makes the promise true: the band the student
agreed to is the band that gets stored. Nothing re-derives a priority inline.

**One writer per stateful thing.** `lifecycle/transition()` is the only function
that writes `Complaint.status` — and therefore the only place `respondedAt`,
`resolvedAt`, `closedAt`, `reopenCount` and the SLA due dates are stamped. A
status the event feed cannot explain is unreachable by construction.

---

## 5. The conversation engine

### The core abstraction: categories declare, the engine decides

A category schema lists the information that *may* be useful. It contains no
control flow — no "if hazard then ask about danger" written as code. The engine
reads the declarations and decides what to actually ask.

```ts
interface Slot {
  key: string;
  question: string;
  type: 'enum'|'multi'|'text'|'number'|'boolean'|'location'|'date'|'media';
  options?: { value; label; hints?: string[]; hazard?: Hazard }[];
  importance: 'REQUIRED' | 'RECOMMENDED' | 'OPTIONAL';
  askIf?: Condition;              // conditional relevance
  infoGain: number;               // 0..1 ordering weight
  safetyCritical?: boolean;       // jumps the queue
  criticalValues?: unknown[];     // values that mean live danger
  priorityDiscriminating?: boolean;
  signal?: 'SCOPE'|'IMPACT'|'DURATION'|'RECURRING'|'PERSON_AT_RISK';
  extractHints?: string[];
  unsureDefault?: unknown;        // what "I'm not sure" resolves to
}
```

There are 13 of these in `src/lib/engine/schemas/`: NETWORK, ELECTRICAL,
CLASSROOM, HOSTEL, HOSTEL_FOOD, WATER, SANITATION, FURNITURE, SECURITY,
TRANSPORT, CANTEEN, LIBRARY, LAB_OTHER. Shared slot shapes live in `shared.ts`.

**Adding a 14th category requires no engine changes** — it declares its `signal`
slots and `hazard` options and the existing rubric scores it.

### `askIf` is data, not a predicate

```ts
type Condition =
  | { slot: string; op: 'eq'|'ne'|'in'|'nin'|'filled'|'unfilled'; value?: unknown }
  | { and: Condition[] } | { or: Condition[] } | { not: Condition };
```

A serializable DSL rather than JS functions, evaluated by ~40 lines in
`condition.ts`. The cost is small; the payoff is that schemas can move from
TypeScript into an admin-editable database table later without rewriting the
engine. One subtlety: a slot that is `UNKNOWN` or `SKIPPED` counts as **not
filled**, so a follow-up is never asked on the back of an answer the student
never gave.

### Next-question selection

```
score(slot) = (safetyCritical ? 1000 : 0)
            + importanceWeight            REQUIRED 100 · RECOMMENDED 40 · OPTIONAL 10
            + infoGain × 20
            + (priorityDiscriminating ? 15 : 0)
```

Candidates are slots that are unresolved, not already asked, and whose `askIf`
currently passes. Highest score wins; **ties break on declaration order**, which
makes a transcript stable and snapshot-testable.

The `1000` is what produces the behaviour in the exposed-wiring example: the
danger question outranks everything the moment a hazard makes it relevant.

### Stop condition

```
complete when:
    no REQUIRED slot is unresolved
AND (no RECOMMENDED slot is still askable  OR  askedSlots.length >= 6)

short-circuit: a safetyCritical slot answered with one of its criticalValues
               stops the conversation immediately, regardless of anything else
```

Four distinct stop reasons are reported and surfaced: `SAFETY_SHORT_CIRCUIT`,
`ENOUGH_INFORMATION`, `QUESTION_BUDGET_REACHED`, `NOTHING_LEFT_TO_ASK`.

### "I'm not sure" never blocks

Every slot accepts `[I'm not sure]` and (unless REQUIRED) `[Skip]`. A REQUIRED
slot answered "not sure" falls back to its `unsureDefault` and is recorded as
`state: 'UNKNOWN'`. The defaults are chosen to be **pessimistic where safety is
involved**: `person_at_risk` has `unsureDefault: true`, so "I don't know if
anyone's in danger" is treated as danger.

### Provenance on every value

```ts
type SlotValue = {
  value: unknown;
  state:  'FILLED' | 'UNKNOWN' | 'SKIPPED';
  source: 'EXTRACTED' | 'ANSWERED' | 'DEFAULTED';
  confidence: number;
};
```

This is what makes the "here's what I understood, edit anything" screen possible,
and what lets classification compute how much of its output rests on real answers
versus defaults.

Editing an answer re-evaluates downstream `askIf` conditions, so invalidated
follow-ups disappear rather than lingering with stale answers.

---

## 6. The AI part, in detail

### 6.1 Why hybrid, concretely

The deterministic engine is the default and always runs. The LLM is an adapter in
front of it that improves *extraction quality only*. Measured on the same engine,
same sentences, both extractors answering faithfully
(`scripts/layer3-compare.ts`):

| Sentence | Rules | LLM | What the LLM adds |
|---|---|---|---|
| "exposed electrical wiring near the hostel entrance in Boys Hostel A" | 2 questions | 1 | pre-fills `problem_type` + `safety_hazard` |
| "No power in the whole of Boys Hostel A since yesterday, nothing sparking or smoking, and I have an exam tomorrow" | 2 | 1 | adds `scope = BUILDING` |
| "nobody in my wing of Boys Hostel A can get online since last night" | 4 (incl. a manual category pick) | **0** | keywords cannot classify this at all |

The planning-time estimate was "skips ≥3 questions". It only holds on the third
sentence, and the reason is instructive: on the first, better extraction *detects
a hazard*, which **unlocks** the person-at-risk question. A better extractor buys
a more relevant question, not always a shorter list.

### 6.2 The provider

`src/lib/llm/groq.ts`. Groq is OpenAI-compatible, so the `openai` SDK v7 works
pointed at `https://api.groq.com/openai/v1`.

| Setting | Value | Why |
|---|---|---|
| model | `openai/gpt-oss-20b` | `strict: true` JSON schema is only supported on `openai/gpt-oss-20b` / `-120b` on Groq. Not on the Llama models. |
| `temperature` | `0` | Extraction must be reproducible. |
| timeout | 4000 ms | A student is waiting; degrading to rules is better than a spinner. |
| `maxRetries` | 1 | |
| `reasoning_effort` | `'low'` for `openai/gpt-oss*` | See the defect below. |
| `max_completion_tokens` | 1200 (JSON), 300–400 (prose) | Reasoning tokens are billed against this budget. |

`getLlmProvider()` returns a `nullProvider` (`available: false`) when no key is
set, so callers skip prompt construction entirely rather than building a request
that will fail.

### 6.3 Strict-mode JSON schemas, and the sentinel

Groq's strict mode requires **every property to be `required`** and
`additionalProperties: false`. There is no way to express "the model may omit
this field". So the schemas use an explicit `"unknown"` sentinel:

```ts
case 'enum':
  return {
    type: 'string',
    enum: [...optionValues, 'unknown'],
    description: `${slot.question} Meanings — ${legend}. ` +
                 `Use "unknown" unless the report clearly indicates one of these.`,
  };
```

`legend` is the fix for a real defect. Given bare enum keys, the model chose
between `ONE_DAY` and `MULTI_DAY` **on the key names alone** and read "since
yesterday" as several days. Every enum property now carries a
`VALUE = student-facing label` legend, so the model sees the meaning the student
would see.

Two slot types are excluded from extraction (`extractableSlots`): `media` (can't
be filled from text) and free `text`. The second is deliberate — asked to fill
"anything else worth adding?", the model echoes the entire report back, which then
appears twice in the summary and the description.

### 6.4 Two calls, not one

Classification and slot extraction are separate calls, because **the slot set is
not known until the category is**, and a single strict schema cannot cover both.

```
text ──► [classify call]  strict enum over 13 category keys + "unknown"
             │
             ▼
        category known
             │
             ▼
     [extract call]  strict schema built from THAT category's slots
```

When the category is already known (the student picked it, or a later message in
an ongoing draft), only the second call runs.

The classification prompt is explicitly biased toward abstaining:

> Answer "unknown" if the report does not clearly belong to one of them — an
> unknown answer makes the system ask the student, which is far better than a
> wrong label.

### 6.5 The rules extractor, and the negation algorithm

`extract/rules.ts` is both the no-key path and the fallback. It never guesses
beyond a literal phrase match.

**Category guess:**

```
for each category:
    hits = keyword matches
         + option-hint matches from slots that are NOT signal slots
    confidence = min(0.95, 0.5 + 0.15 × hits)

if the top two categories have equal hit counts → cap confidence at 0.45
                                                   (the student picks instead)
accept a category only at confidence ≥ 0.60
```

The "NOT signal slots" clause is a fix for a genuine bug. Scope, impact and
duration are circumstances *every* category shares. Once every category worded
its own scope options, "nobody in my wing can get online" classified as **HOSTEL**
on the strength of the hint "my wing" — a circumstance voting on a category.

**Negation-aware hint matching.** This one shipped a real safety bug first:

> "There is no power in Boys Hostel A, **nothing sparking or smoking**"

matched the hints `sparking` and `smoking`, filled `safety_hazard` with
`[SPARKING, SMOKE]`, tripped the safety short-circuit, and submitted a routine
power cut as **CRITICAL**.

```
hintMatches(text, phrase):
    if the phrase itself starts with a negator ("no internet", "cant log in",
       "nobody can") → plain substring match, never suppressed
    otherwise, for each occurrence of the phrase:
        look at the 3 tokens immediately before it
        if any is a negator → this occurrence is suppressed, keep scanning
        else → match
    one un-negated occurrence is enough
```

The negator set is 18 words (`no`, `not`, `nothing`, `none`, `never`, `without`,
`isnt`, `cant`, `nobody`, `neither`, …) and is exported so the tests assert
against the real list rather than a copy. `tests/engine/negation.test.ts` pins it.

The carve-out for self-negating hints matters: "no internet" and "nobody can get
online" are the normal way to report a network problem, and suppressing them
would break the most common case.

### 6.6 Merging rules and LLM output

```ts
const rules = extractFromText(text, schema, options);   // always runs
if (!provider.available) return rules;                   // no-key path ends here
...
return { slots: { ...baseline, ...mapped.slots } };      // LLM overwrites on conflict
```

The policy:

- **Rules always run first**, regardless.
- **On a conflict, the LLM wins.** It reads "everyone else is fine, only mine"
  correctly, where keyword matching returns `MANY`.
- **Where the LLM answers `"unknown"`, a keyword hit still stands.**
- **Any failure leaves the rules result byte-for-byte as Layer 2 produced it** —
  the fallback path is not a degraded second implementation, it is the same code.

`DraftView.extractionSource` (`'RULES' | 'LLM' | null`) reports which extractor
read the last message. It is per-turn and not persisted.

### 6.7 Two guards that make an LLM value safe to show a student

The governing principle: **a missing slot costs one question; a wrong slot is
shown to the student as fact.** So `mapExtraction()` is aggressively skeptical.

**Guard 1 — every value is checked against the slot's declared options.**

```ts
case 'enum':  return allowed?.includes(String(value)) ? String(value) : undefined;
case 'multi': keep only values in `allowed`; undefined if none survive
```

`undefined` means "the model returned something this slot cannot hold" — the field
is dropped and logged, never stored. Anything not in the sentinel set
(`""`, `"unknown"`, `"null"`, `"n/a"`, `"none stated"`, `[]`, `null`) but also not
valid is rejected the same way.

**Guard 2 — the model never picks a database row.**

Locations come back as a free-text **phrase**, quoted as the reporter worded it:

```
"The place, quoted as closely as possible to how the reporter worded it
 (e.g. 'CSE Block 2nd floor'). Do not invent or normalise a place name."
```

That phrase is then resolved to an id by `matchLocation()` — the same
conservative deterministic matcher the rules path uses, which requires **every
significant word** of a location's name to appear, so "hostel" alone never
resolves to one of three hostels. The model influences *which* location is
considered; it cannot name one.

Confidence values encode the hierarchy: an explicit answer (1.0) > an LLM
extraction (0.8) > a keyword hit (0.75) > a resolved location phrase (0.7).

### 6.8 Prose: the title

The only other LLM call. `generateTitle()` sends the *already-extracted facts*
plus the raw text and asks for one line under 80 characters, then
`sanitizeTitle()` strips the model's habits: a "Title:" prefix, surrounding
quotes, a trailing period, newlines. Anything under 6 or over 90 characters is
rejected as not-a-title.

`buildTitle()` — a deterministic template over the classification — is the
fallback, so no-key runs get a sensible title and nothing downstream branches on
whether a key exists.

Note what is *not* LLM-written: **incident** titles (`buildIncidentTitle`) are
deterministic `"CSE Block — Wi-Fi Outage"`, because staff read them as identifiers
across a queue. And §36's student-facing incident message is templated, not
generated, because it is a status report the system is certain about and it must
read identically with no key.

### 6.9 Defects the AI work exposed, and the fixes

| Defect | Cause | Fix |
|---|---|---|
| Title call returned empty content every single time | `max_completion_tokens: 60`; gpt-oss bills **reasoning** tokens against that budget, so the reasoning pass consumed it all | Raise to 300–400 and set `reasoning_effort: 'low'` for `openai/gpt-oss*` |
| "since yesterday" read as several days | Bare enum keys — the model was choosing on key names | Every enum property carries a `VALUE = label` legend |
| "nothing sparking or smoking" filed as CRITICAL | Keyword matching ignored negation — **a Layer 2 bug on the no-key path**, not an LLM issue | `hintMatches()` negation window (§6.5) |
| "nobody in my wing can get online" classified as HOSTEL | Shared scope-option hints voted on category | `extractCategory` skips options on `signal` slots |
| "exposed **electrical** wiring" didn't match the hint `exposed wiring` — the spec's own example sentence | An intervening word defeats phrase matching | The full phrase is listed explicitly in the hints |

---

## 7. Classification: turning answers into facts

`engine/classify.ts` — pure. It converts a filled slot set into the flat fact set
everything downstream reasons about.

**It must never match on a category's slot keys or option values.** Categories
word their questions differently. Two declarations carry the meaning across
category boundaries:

- `slot.signal` — `SCOPE` | `IMPACT` | `DURATION` | `RECURRING` | `PERSON_AT_RISK`
- `option.hazard` — maps a dangerous option onto one cross-category `Hazard`
  vocabulary of 16 values (FIRE, SMOKE, SPARKING, EXPOSED_WIRE, MAJOR_LEAK,
  SECURITY_THREAT, …)

That indirection is why one rubric scores all 13 categories and why a 14th is
purely additive.

Output:

```ts
{
  categoryKey, subcategoryKey, scope, scopeBucket, impact, duration,
  hazards: Hazard[],           // sorted worst-first by HAZARD_ORDER
  personAtRisk: boolean | null, // null = never established ≠ an answered "no"
  reportedRecurring: boolean,
  locationId, locationName, locationType, locationCriticality,
  signature: string,
  confidence: number,          // 0..1 — share of REQUIRED+RECOMMENDED slots
  unresolved: string[]         //        that hold a real FILLED answer
}
```

### The signature

```
signature = "CATEGORY|SUBCATEGORY|locationId|scopeBucket"
```

The plan called for a hash. A readable composite groups identically, survives a
SQL `GROUP BY`, can be read off a row when a dedup decision needs explaining, and
— critically — is **reversible**. `parseSignature()` reads the scope bucket back
off a stored complaint, which is how the dedup candidate query gets a value that
is not a column of its own.

`scopeBucket` collapses five scope answers into three buckets, because four
students describing one outage as "the whole floor", "everyone here" and "the
whole block" must land on the same signature:

```
ONLY_ME, FEW           → ISOLATED
MANY, BUILDING, CAMPUS → WIDESPREAD
(never answered)       → UNKNOWN     ← acts as a wildcard in dedup
```

---

## 8. Priority: the rubric

`engine/priority.ts` — pure, additive, and it **never returns a bare band**.

```
score = categoryBase        SECURITY 45 · ELECTRICAL 40 · WATER 35 · HOSTEL_FOOD 30
                            NETWORK/CLASSROOM/LAB/TRANSPORT 25 · HOSTEL/SANITATION/CANTEEN 20
                            LIBRARY 15 · FURNITURE 10          (default 20)
      + worstHazard         FIRE 80 · GAS_LEAK 75 · SMOKE 70 · ELECTRIC_SHOCK 70 · CHEMICAL 65
                            SPARKING 60 · MAJOR_LEAK 60 · SECURITY_THREAT 60 · BURNING_SMELL 55
                            FLOODING 55 · STRUCTURAL 50 · EXPOSED_WIRE 50 · HARASSMENT 45
                            INJURY 30 · FOOD_ILLNESS 30 · SEWAGE 25
      + personAtRisk        40   (only when a hazard was also reported)
      + scope               ONLY_ME 0 · FEW 10 · MANY 25 · BUILDING 35 · CAMPUS 50
      + impact              EXAM 30 · CLASS 20 · ASSIGNMENT 10 · NONE 0
      + duration            MULTI_DAY 15 · ONE_DAY 10 · TODAY 5 · JUST_NOW 0
      + location            round(criticality × 15)      criticality is a seeded 0..1;
                                                          unknown location assumes 0.5
      + recurrence          +10 if ≥3 same-signature complaints in 30 days
                            +5  if the student says it recurs (never both)

band  =  ≥120 CRITICAL · ≥75 HIGH · ≥40 MEDIUM · else LOW
```

Three design points worth calling out:

**Only the worst hazard scores.** Smoke *and* a burning smell is one fire, not
two. The others are listed in the reason's `detail`.

**`INJURY` at 30 is deliberately below "broken classroom equipment".** A bench
with a nail in it is an injury risk, not a campus emergency; it needs scope or
impact behind it to reach HIGH, which is what the spec's own ordering implies.

**Hard overrides jump to CRITICAL regardless of score** — a fire should not have
to out-point a campus-wide outage:

```
overrides = safetyShortCircuit                       (a safety slot hit a criticalValue)
          ∪ any hazard in CRITICAL_HAZARDS           (FIRE SMOKE GAS_LEAK CHEMICAL
                                                      ELECTRIC_SHOCK MAJOR_LEAK
                                                      FLOODING SECURITY_THREAT)
          ∪ (personAtRisk AND any hazard reported)
```

`safetyShortCircuit` is passed **in** as an input rather than re-derived. A
schema's `criticalValues` is the single source of truth for "stop asking, this is
dangerous", and feeding that same signal to the rubric is what guarantees a
halted conversation can never submit as anything but CRITICAL.

### Reasons, not just a band

Every contributing term produces a `PriorityReason { code, label, points, detail }`
where `label` is a **sentence**: "Multiple students are affected.", "An
examination is being disrupted.", "Live wiring is exposed." They are ordered
override-first, then worst-points-first, with the category floor last.

- **Students** see `studentReasons()` — the sentences, minus the category floor
  ("Electrical issues start at 40" explains arithmetic, not urgency).
- **Staff** see the sentences *plus* points, details, the total score, the routing
  confidence and the signature.
- **Routing uncertainty is never student-facing.** A low confidence score is not
  something a student can act on, so an unrouted complaint reads "to be assigned
  by the campus office".

---

## 9. Routing

`engine/routing.ts` — pure; the caller loads `RoutingRule` rows, this decides.

```
candidates = rules where category matches
                 AND (rule has no subcategory OR it matches)
                 AND (rule has no locationType OR it matches)
                 AND (rule has no locationId  OR it is in the complaint's ancestor chain)

specificity: exact location   20 + max(0, 5 − distance-up-the-ancestor-chain)
             location type    10
             category default  0

winner = highest specificity, then highest confidence, then rule id (stability)

confidence = rule.confidence − (location unknown ? 0.15 : 0)
needsTriage = confidence < 0.50
```

A nearer ancestor beats a distant one, so a rule pinned to a specific room beats
one pinned to its building. No matching rule at all → triage, never a guess.

Every decision carries a `reason` string: *"Routed by the hostel location rule for
ELECTRICAL (location not identified, confidence reduced)."*

---

## 10. Duplicate detection and incidents

### The insight that removes the need for embeddings

**Dedup runs on structured attributes *after* classification, not on raw text.**

"WiFi isn't working in CSE Block" and "No internet connection in CSE building"
share almost no words — trigram similarity between the four spec example
sentences runs **0.10–0.20** — but both normalise to
`NETWORK / WIFI_OUTAGE / CSE_BLOCK`. The classification has already done the
semantic work. Text similarity is a tie-breaker worth 0.15, never the deciding
signal.

Groq has no embeddings API, which is what forced this design. It turned out
better: the unit tests pin the four spec cases at deliberately *low* text
similarity and they still auto-link.

### The score

```
score = 0.55 × signatureMatch
      + 0.15 × locationProximity
      + 0.15 × textSimilarity      (pg_trgm similarity(), from SQL)
      + 0.15 × timeProximity

≥ 0.70  → auto-link to the existing open incident
0.45–0.70 → open its own incident AND write a DUPLICATE_SUGGESTED event;
            staff get a "Merge into INC-xxx" panel
< 0.45  → new incident
```

**`signatureMatch`** — how much the *problem* matches. It deliberately excludes
the location leg of the stored signature, because location is scored separately;
counting it twice would punish a same-building/different-room pair across 0.70 of
the score instead of 0.15.

```
if category differs                          → 0
match = 1
if both subcategories known  → ×1 if equal, else ×0.35   (a genuinely different problem)
if one is missing            → ×0.75                     (evidence absent, not contradictory)
if both scope buckets known  → ×1 if equal, else ×0.6
if either is UNKNOWN         → no penalty — UNKNOWN is a WILDCARD
```

The wildcard rule is load-bearing. The *first* complaint of an outage usually has
the fewest answers; if an unanswered scope question made it unmatchable, it would
open its own incident every time. The spec's fourth student names no scope and no
building at all and still links at 0.81.

**`locationProximity`** — the measure is *how specific the deepest shared ancestor
is*, not how many hops apart two locations are:

```
same location id                → 1.0
either location unknown         → 0.2      (can neither confirm nor deny)
no shared ancestor              → 0
depth of deepest shared node:
    ≥2 (floor or below)         → 0.7
    ==1 (building)              → 0.5
    0  (campus root)            → 0.1
```

This was written as hop-distance first and a test caught it: two *buildings* are
one hop apart through the campus root, which scored them 0.7 "same floor".
Sharing the root is the weakest possible relationship. Containment then falls out
for free — a room and its own floor share that floor, so "network is down on the
third floor" and "no wifi in room 302" score 0.7 with no special case.

**`timeProximity`** — linear decay across the *category's own* window:

```
proximity = max(0, 1 − hoursApart / dedupWindowHours)
```

The window is per-category (`SECURITY`/`TRANSPORT`/`HOSTEL_FOOD` 12h · most 24h ·
`HOSTEL`/`LIBRARY` 48h · `FURNITURE` 72h) because a burst pipe twelve hours apart
is two floods, and a broken chair three days apart is one chair.

**Ties break towards the earlier complaint**, so a burst of near-simultaneous
reports converges on one incident rather than racing between two.

### Candidate selection

`dedup/candidates.ts` — the one impure module. Candidates are drawn by
**category + time window + open incident**, capped at 100, with
`GREATEST(similarity(title), similarity(description))` computed in SQL.

Signature equality is deliberately **not** a filter — that is what would break the
`UNKNOWN` wildcard. `pg_trgm` has no Prisma binding, so this runs through
`$queryRaw` against GIN indexes created in a raw SQL migration.

### Incidents

**Every complaint belongs to exactly one incident.** A size-1 incident is just a
complaint and the UI hides the framing (`isSharedIncident(count) = count > 1`).
This removes all nullable-incident branching from dashboards, merges and
analytics. A merge that empties an incident deletes it — an incident with no
members is a leftover, not a record.

**`affectedCount` counts distinct *reporters*, not complaints.** The spec says
"47 students have reported this issue"; one student filing twice is one affected
student. It is always recomputed by `recountIncident()`, never incremented.

**Priority = worst member, escalated by scale:**

```
incidentPriority = raiseBand(max(member bands), escalationFor(affectedCount))
                   where 20+ affected → +2 bands, 5+ → +1, else 0
```

Priority never averages — one student reporting sparking inside a wider outage
must not be diluted by four who reported "no power". And **scale escalates the
incident, never the member**: re-banding a stored complaint behind the student's
back is exactly what the single-assessor rule exists to prevent.

**Status is derived, never written by hand**, and the asymmetry is deliberate:

```
all members closed/rejected/duplicate → CLOSED
all members settled                   → RESOLVED
ANY member being worked on            → IN_PROGRESS   ← one is enough
otherwise                             → OPEN
```

Active as soon as **one** member is being worked on, because that is true. Resolved
only when **every** one is, because thirty-nine of forty students still have no
Wi-Fi otherwise.

---

## 11. Lifecycle

`lifecycle/machine.ts` — the transition table and nothing else. No Prisma, no
clock.

```
SUBMITTED → ANALYZING → ASSIGNED → ACKNOWLEDGED → IN_PROGRESS → RESOLVED → CLOSED
                            │            │             │            │
                            │            └─── WAITING_FOR_STUDENT ──┘
                            │                                       │
                            └── REJECTED · DUPLICATE          REOPENED ──┘
```

Each of the 25 rules carries `{ from, to, actors[], label, narration, requiresNote? }`.

- **`label`** is the imperative for the staff button: "Accept", "Start work".
- **`narration`** is the past tense for the timeline: "Investigation started",
  "Assigned to IT Services". §20's feed must never surface a raw enum.
- **`requiresNote`** marks moves that are meaningless without an explanation —
  reject, reopen, request-information.

**`ASSIGNED → IN_PROGRESS` is deliberately absent.** `respondedAt` is stamped on
`ACKNOWLEDGED` and the response SLA is measured against exactly that stamp; a
shortcut would leave a worked-on complaint with no response time at all. The
progress-update route acknowledges first rather than skipping.

**Submission walks the first two steps.** Analysis and routing really have already
run by the time a complaint row exists, so `createComplaint` drives
SUBMITTED → ANALYZING → ASSIGNED through `transition()` — which gives the student's
tracker "10:20 submitted / 10:21 assigned to IT" for free. A complaint whose
routing could not place it stops at ANALYZING and waits for a human.

**`pathTo()` — BFS over the transition graph.** Used *only* by the incident-wide
action, where "resolve all forty of these" meets forty members at forty different
rungs:

```
BFS from `from`, expanding only edges this actor may take,
skipping any edge that requiresNote unless it is the final destination
→ the shortest legal path, or null
```

Every rung is still a real transition with its own event and its own timestamps,
so `respondedAt` gets stamped on the way past. Nobody is carried *through*
"rejected" en route somewhere else. A single complaint never walks a path — its
buttons come from `nextStatuses()`, where the ladder's strictness is the point.

**Event ordering.** `ComplaintEvent` is loaded ordered by `[createdAt, id]`.
Submission writes three events inside one millisecond and Prisma's `DateTime`
only stores milliseconds; cuid v1 sorts by creation time, so the id is the
tiebreak that keeps the feed in the order things actually happened.

---

## 12. SLA and escalation

### The promise

```
dueDatesFrom(start, profile, band):
    responseDueAt   = start + profile.response[band]     minutes
    resolutionDueAt = start + profile.resolution[band]   minutes
```

Both clocks start at the **same instant** — the moment the complaint reaches a
department — so a fast acknowledgement buys no extra repair time and a slow one
costs none. Defaults (minutes), overridable per department:

| Band | Response | Resolution |
|---|---|---|
| CRITICAL | 15 | 240 (4 h) |
| HIGH | 60 | 1440 (1 d) |
| MEDIUM | 240 | 4320 (3 d) |
| LOW | 1440 | 10080 (7 d) |

A department with no profile falls back to these rather than getting no deadlines
— a complaint with no due dates can never breach and would sit in the queue
forever without anyone noticing.

The due dates are stamped by `transition()`, not beside it: entering ASSIGNED
(re)starts both; ACKNOWLEDGED/IN_PROGRESS only fill a gap; REOPENED clears them
along with `respondedAt` and `escalationLevel`, because a reopen is a fresh
promise on a second attempt.

### The ladder

```
slaState(row, now):
    settled complaint                                  → nothing to breach, level 0
    responseBreached   = not responded  AND now ≥ responseDueAt
    resolutionBreached = not resolved   AND now ≥ resolutionDueAt
    breachedTwice      = resolutionBreached AND now ≥ 2×resolutionDueAt − createdAt

level 1  RESPONSE      → notify the department manager
level 2  RESOLUTION    → notify the administrator
level 3  RESOLUTION_2X → notify the administrator AND flag
```

Two properties make this safe to run from a once-a-minute cron, a dev endpoint
and a test script against the same row:

**A rung is only walked when its own failure actually happened.**
`escalationPlan()` filters the ladder by the breach flags rather than walking
0 → 1 → 2. A complaint acknowledged in two minutes and then left unrepaired for a
week goes **straight to level 2** — writing a "nobody responded" event on the way
past would put a failure in the timeline that never occurred.

**Escalation only ever moves up.** `escalationLevel` records the rung reached and
the sweep never moves down from it. A missed minute costs nothing; two triggers
cannot double-report. And `escalationLevel >= 3` **is** the "flagged" state — no
separate boolean that could disagree with it.

`slaOutcome()` is the retrospective twin: it ignores `now` and reads the stamps,
which is what makes "did this complaint closed last month meet its SLA?"
answerable. The dashboards aggregate the same definition in SQL, and
`scripts/layer10-nokey.ts` recounts one against the other complaint by complaint.

### The demo clock

`/api/dev/advance-clock` (dev only, admin only) **ages the target complaint**
rather than moving a simulated global "now". Every pure module already takes `now`
as an argument and the worker runs in a separate process, so a global offset would
have to be persisted *and* threaded through everything. Ageing one row achieves
the same demo with zero changes to the domain layer, and it agrees with the worker
for free.

---

## 13. Queue ranking

`queue/rank.ts` — pure. §21 asks for Critical → High → SLA-approaching → Normal.

```
bucket:  settled              → DONE      (sinks, but stays findable)
         priority CRITICAL    → CRITICAL
         priority HIGH        → HIGH
         breached or at-risk  → AT_RISK
         otherwise            → NORMAL

slaRisk: the *live* deadline is responseDueAt until acknowledged,
         resolutionDueAt afterwards
         now ≥ due                        → BREACHED
         remaining / window ≤ 0.25        → AT_RISK
         otherwise                        → OK

sort: bucket → breached-before-at-risk → band → score desc → oldest first
```

The due dates are nullable on purpose. Before the SLA layer stamped them, the
at-risk bucket simply never fired and the order degraded to band → score → age —
and the unit tests pinned the bucket with synthetic dates so it was already proven
when the real dates arrived.

---

## 14. Resolution, reopen, feedback

`feedback/service.ts`. Three rules shape it:

**The question belongs to the reporter, and nobody else.** `confirmResolution()`
compares against `reporterId`, not a role. An admin can *see* a complaint without
being the person it happened to. Staff are also not offered a "Close" button on a
RESOLVED complaint even though the transition table permits it — legality and
whose decision it is are different questions.

**A rating is an opinion, not a lifecycle step.** It never moves the complaint.
It is allowed on RESOLVED *or* CLOSED, but `Feedback.resolutionConfirmed` records
which, so a rating given without confirming the fix cannot be counted as a
confirmation. **One `Feedback` row per complaint**, or the campus average becomes
a count of button presses.

**Both halves are recorded.** `RESOLUTION_CONFIRMED` / `RESOLUTION_REJECTED`
events exist because a status change alone does not record that a *human checked*.

Aggregation (`feedback/satisfaction.ts`) returns `average: null` — never a
misleading `0` — when nothing has been rated, plus a histogram and the
share-at-4-or-5 that the dashboard calls "student satisfaction".

---

## 15. Analytics

`analytics/` is pure except `sql.ts`, which owns every `$queryRaw`.
`analytics/service.ts` composes them and is the **only** thing the pages and
`/api/analytics/overview` call — a number on a dashboard must be a number the API
can be asked for, or the two drift.

### Heatmap (§28)

Bands are **relative to the busiest place on campus**, not absolute:

```
intensity = location.total / busiest.total
HIGH   when total ≥ 3 and intensity ≥ 0.6
MEDIUM when total ≥ 3 and intensity ≥ 0.3
LOW    otherwise
```

An absolute threshold is wrong twice over — everything green in a quiet month,
everything red in a bad one — and the administrator's question here is comparative.
The floor of 3 stops a quiet week's three-complaint building being painted red.

Rows are rolled up to the **building** via a recursive CTE. The spec names
buildings ("CSE Block 🔴 High") but students name whatever they can, usually a
room; eleven scattered room-level complaints are one problem block.

### Recurring-trend detection (§27)

```
window = the last 4 monthly counts per (building, category), zeroes included

reject unless:
    occurrences in window ≥ 12          (volume has to matter)
    latest month ≥ 4                    (the trend has to still be live)
    growth ≥ 0.5                        (the direction has to be up)
    AND (first month > 0  OR  ≥3 active months)     ← the baseline floor

growth = (last − first) / first,  or  `last` when first is 0 (rank only, never a %)
severity = ACT when ≥3 consecutive rising months or growth ≥ 1.0, else WATCH
```

Growth is measured **end to end**, not month over month, so one flat month in the
middle does not cancel a trend that tripled.

The baseline floor is there because real data broke the detector. With every
complaint inside a single month it reported *"up 5200% since March"* against
months that predate the system's existence. Where there is no baseline the signal
says **"up from none"** and sets `hasBaseline: false` — `growthRate` must never be
formatted as a percentage without checking it.

Each signal carries a narrative with the numbers in it ("12 in January to 43 in
April") and a §30 suggestion aimed at the infrastructure, not the tickets:
*"Inspect the network hardware and access-point coverage in CSE Block — 31
complaints in 4 months suggests a fault that keeps coming back rather than 31
separate faults."*

### Campus health score (§34)

```
health = 100 − min(20, openCritical × 4)
             − slaBreachRate  × 25
             − reopenRate     × 15
             − min(15, recurringACT × 3 + recurringWATCH × 1)
             + satisfactionFraction × 10          → clamp 0..100

band: ≥80 GOOD · ≥60 FAIR · else POOR
meaningful only at ≥10 complaints in the window
```

**The score is never returned bare.** `healthScore()` returns five signed terms,
each with the measurement behind it — *"SLA compliance −9.0: 36% of complaints
with a deadline missed it"* — and every surface prints them. Same discipline as
the priority reasons: "78/100" is an assertion; the terms are an argument someone
can check and act on.

No feedback is not bad feedback: an unrated campus earns no bonus rather than
being scored as if every student were unhappy.

### Charts

Server-rendered CSS and SVG in `components/charts.tsx`. No chart library, no
client JS. One series per chart, and **colour is never the only channel** — every
band is printed as a word beside its swatch, because two of the three status
colours fall below 3:1 contrast on white.

---

## 16. Data model

Postgres 16 + Prisma 7 (`prisma-client` generator, mandatory `PrismaPg` driver
adapter, connection URL in `prisma.config.ts`).

| Model | Notes |
|---|---|
| `User` | STUDENT · STAFF · DEPT_MANAGER · ADMIN, optional `departmentId`, bcrypt hash |
| `Department` | + `slaProfileId` |
| `Location` | self-referencing `parentId` (campus → building → floor → room), `type`, `criticality` 0..1 |
| `ComplaintDraft` | the live conversation: `rawText`, `categoryKey`, `slots` JSON, `askedSlots[]`, `turns[]` — persisted so a refresh is safe |
| `Complaint` | `CMP-####`, classification, `slots` JSON, `priority` + `priorityReasons` JSON, `signature`, `departmentId`, `status`, `incidentId`, `responseDueAt`, `resolutionDueAt`, `escalationLevel`, `reopenCount`, `isAnonymous` |
| `Incident` | `INC-###`, derived `priority` / `status` / `affectedCount` |
| `ComplaintEvent` | append-only timeline: type, actor, message, `meta` JSON |
| `Feedback` | rating 1–5, comment, `resolutionConfirmed` — one row per complaint |
| `SlaProfile` | response + resolution minutes per band |
| `RoutingRule` | the seeded routing table |
| `RecurringSignal` | worker-written trends + suggestions |
| `Attachment` | schema-only (Layer 7 dropped) |

Codes come from Postgres sequences (`complaint_code_seq`, `incident_code_seq`).
`pg_trgm` plus GIN indexes on `title` / `description` are created by raw SQL
migrations.

`isAnonymous` exists from the first migration even though the behaviour was never
built — retrofitting identity-hiding later would touch every query.

---

## 17. API surface

Route Handlers, not server actions — they are curl-testable, which every gate
relies on. Zod schemas are colocated with the handler and reused for LLM JSON
schemas where they overlap.

| Route | Purpose |
|---|---|
| `POST /api/auth/login` · `POST /logout` · `GET /me` | session |
| `POST /api/drafts` | start a conversation from one sentence |
| `GET·POST /api/drafts/[id]` | answer, add a message, set a category, edit a slot |
| `POST /api/drafts/[id]/submit` | assess → persist → walk to ASSIGNED → dedup |
| `GET·POST /api/complaints` · `GET /[id]` | list and detail |
| `POST /api/complaints/[id]/status` | a lifecycle transition |
| `POST /api/complaints/[id]/assign` · `/updates` | assignment, progress notes |
| `POST /api/complaints/[id]/confirm` · `/feedback` | §23 confirm/reject, §24 rating |
| `GET /api/incidents/[id]` · `POST /merge` · `POST /status` | incident view, staff merge, incident-wide action |
| `GET /api/analytics/overview` | the exact numbers both dashboards render |
| `POST /api/analytics/recurring/scan` | the nightly scan, on demand |
| `POST /api/dev/advance-clock` · `/sla-scan` | dev + admin only, disabled in production |

Authorization is real in the handlers (`requireApiRole()`) and in layouts/pages
(`requireRole()`). `src/proxy.ts` (Next 16's renamed middleware) is only an
optimistic cookie check.

A note on the error contract: an illegal transition returns **409 with the legal
alternatives**, so a caller learns what it *could* have done. A stranger asking
for someone else's complaint gets **404**, not 403 — they should not learn it
exists.

---

## 18. How it is verified

Development ran in **12 layers, and no layer started until the previous one's gate
passed**. Three kinds of check:

**1. Unit tests — `npm test`, 414 tests across 24 files.** These *are* the layer
gates. They can be this thorough only because the domain layer is pure: question
selection, condition evaluation, negation handling, transcript snapshots, every
priority band and every hard override case-by-case, routing specificity, dedup
weights and thresholds, incident rollups, the transition table and `pathTo`,
SLA math, queue ordering, satisfaction, heatmap bands, recurrence floors, health
terms.

**2. No-key service-layer scripts** (`scripts/layer*-nokey.ts`) — drive the real
services against a real database with `GROQ_API_KEY=`, and assert exact counts.
These are the authoritative gates: they isolate their own data. `layer10-nokey.ts`
goes further and **recounts every dashboard aggregate against the row-level
modules** — the SQL breach count against `sla/breach.ts`, the building roll-up
against a TypeScript walk of the location tree, the health score against
`healthScore()` — then drives trend detection over a four-month series it creates
and deletes.

**3. API gates** (`scripts/layer*-gate.sh`) — curl against the running app with
real logins, checking the same figures over HTTP, that the rendered page shows
what the API returned, and the RBAC around both. Each also exercises the
refusals: an illegal transition, a student in the staff workflow, another
department's complaint, a reason-less rejection, a rating before there is a
resolution, a second rating, a stranger rating someone else's complaint.

**The no-key run is repeated at every layer**, not just the one that introduced
the LLM. That is the check that keeps the hybrid design honest.

One gate is known-flaky and documented as such: `scripts/layer5-gate.sh` runs
*with* a key, so its fourth student depends on LLM extraction, and it does not
isolate its run — so it can pass on a leftover incident. `layer5-nokey.ts` is the
trustworthy one.

---

## 19. Trade-offs, and what is deliberately not built

| Decision | Cost | Why it was taken |
|---|---|---|
| Question **selection** is deterministic; only **extraction** is LLM-driven | Less conversational flair | Testability, zero-cost operation, no hallucinated questions, real explainability |
| Category schemas live in TypeScript, not the database | Not admin-editable at runtime | Typed, diffable, testable. The serializable `askIf` DSL keeps a later migration additive |
| No embeddings | Semantically distant phrasings rely on post-classification attribute matching | Groq has no embeddings API — and the attribute approach handles the spec's own cases at 0.10–0.20 text similarity. pgvector would be a self-contained upgrade to `dedup/score.ts` |
| Every complaint gets an incident | Slightly odd conceptually | Removes all nullable-incident branching from analytics, merges and dashboards |
| The demo clock ages a complaint instead of moving time | "Advance the clock" is really "age this row" | One real clock, in a system whose pure modules all take `now` and whose worker is a separate process |
| Polling, not websockets | Not live | Adequate at this scale; SSE is a drop-in |
| **No demo seed** (`seed-demo.ts` dropped) | Trends and heatmap density are thin in the running app | The gates compensate by recounting every aggregate against the row-level modules and driving the detector over a temporary real trend — a stronger check than "the dashboard looks populated" |

**Dropped:** attachments and anonymous reporting (Layer 7) — additive, nothing
downstream depends on them; the schema columns already exist.

**Remaining:** faceted search (Layer 11 — the `pg_trgm` GIN indexes and the SQL
`BREACHED` fragment it needs already exist), AI insight narratives (Layer 12 —
numbers from the existing SQL, only the prose to Groq, with the templated
narrative as the no-key fallback), and notifications (deferred — the `ESCALATED`
events already carry the recipient's id and name, so delivery is the only missing
half).

### About the sparse data

Every complaint in a freshly-set-up database was filed by a gate script inside one
month. So: trend detection reports nothing in the running app (it refuses to call
the start of the data a trend), and average resolution times are near zero
(the gates resolve complaints seconds after filing them). **Both are properties of
the data, not the code.** Seeding history is the missing piece — not fixing
analytics.

---

## 20. Where to start reading

If you want to understand this codebase quickly, read these seven files in order.
They are about 1,450 lines total and contain every decision that matters:

1. **`src/lib/engine/types.ts`** — the slot abstraction everything else is built on.
2. **`src/lib/engine/schemas/electrical.ts`** — one category, showing hazards,
   `askIf`, signals and `criticalValues` in use.
3. **`src/lib/engine/next-question.ts`** + **`completeness.ts`** — the whole
   conversation loop, in 155 lines.
4. **`src/lib/engine/extract/index.ts`** — the rules/LLM merge policy, i.e. the
   hybrid design in one function.
5. **`src/lib/engine/extract/llm.ts`** — prompt and schema construction, and the
   two guards that make an LLM value safe to show a student.
6. **`src/lib/engine/priority.ts`** — the rubric, and what "explainable" means here.
7. **`src/lib/dedup/score.ts`** — why this works without embeddings.

Then `plan.MD` §7, which records what each layer's gate actually proved, every
deviation from the plan, and every defect found along the way — including the ones
that were the deterministic path's fault rather than the model's.
