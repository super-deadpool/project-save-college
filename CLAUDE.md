# CLAUDE.md

## 1. What this is

Smart Complaint Management System — an AI-assisted campus complaint platform. Students report problems through a conversation instead of a form; the system discovers what information it still needs, classifies and prioritises the issue, routes it to a department, groups duplicates into incidents, tracks resolution, and turns history into campus insights.

Core idea (spec §1): **don't make the student know what information is required — make the system discover it.**

- **Design + layer plan:** `plan.MD` ← read this, not the spec
- **Current layer:** see §7 below
- **Deferred:** notifications (§35/§36); no embeddings/pgvector

## 2. Read this, not that (token discipline)

| Don't | Do |
|---|---|
| Read `smart_complaint_management_system.md` in full (24KB requirements doc) | Read `plan.MD` §3–§6 — every design decision derived from the spec is already encoded there. `grep` the spec for a `§` number only when implementing that specific feature. |
| Read `src/generated/prisma/**` | It's generated and huge. Types come from imports. |
| Read `prisma/migrations/**` SQL to learn the schema | Read `prisma/schema.prisma` |
| Read all 13 files in `src/lib/engine/schemas/` | `grep` for the slot key or category key. Shared slots (scope/impact/duration/recurring/location/details/person-at-risk/health-impact) live in `schemas/shared.ts` — check there before adding one. |
| Pipe `seed-demo.ts` output through context | Check with a single SQL `count` |
| Re-derive a settled decision | It's in `plan.MD` §1 or §8 with the reasoning |

Prefer `grep`/`rg` over reading whole files. When a task spans many files, delegate the sweep and keep the conclusion.

## 3. Commands

```bash
docker compose up -d        # Postgres + Adminer
npm run dev                 # app        → :3000
npm run worker              # node-cron: SLA scan, escalation, recurrence   (Layer 8)
npm run db:migrate          # prisma migrate dev
npm run db:seed             # departments, locations, routing rules, SLA profiles, demo users
npm run db:seed:demo        # ~800 historical complaints (needed for analytics) (Layer 10)
npm run db:studio
npm test                    # vitest — the layer gates

./scripts/layer3-gate.sh              # end-to-end draft→submit over the API (needs npm run dev)
npx tsx scripts/layer3-compare.ts     # rules vs LLM on the same sentences, same engine
./scripts/layer4-gate.sh              # priority + why + department, shown vs stored (needs npm run dev)
GROQ_API_KEY= npx tsx scripts/layer4-nokey.ts   # the no-key run, through the service layer

GROQ_API_KEY= npx tsx scripts/layer5-nokey.ts   # the Layer 5 gate — isolates its own history, asserts exact counts
./scripts/layer5-gate.sh              # §16 from four real logins + incident RBAC (needs npm run dev)
```

Ports: app **3000** · Postgres **5433** (not 5432 — avoids clashing with a local instance) · Adminer **8080**

Env: `DATABASE_URL`, `AUTH_SECRET`, `GROQ_API_KEY` (optional), `GROQ_MODEL` (default `openai/gpt-oss-20b`). See `.env.example`.

Demo logins (all `password123`): `student@campus.edu` · `staff@campus.edu` (IT) · `staff.mnt@campus.edu` (Maintenance) · `manager@campus.edu` · `admin@campus.edu`.

## 4. Architecture map

```
src/app/
  login/  report/  complaints/[id]/  queue/  incidents/[id]/  dashboard/
  api/{auth,drafts,complaints,incidents,analytics,uploads,dev}/   # Route Handlers
src/lib/
  db.ts                      # PrismaClient + PrismaPg adapter
  auth/                      # jwt, session, role guards
  llm/
    provider.ts              # LlmProvider: json() + text(), both return null on any failure
    groq.ts  null.ts  index.ts   # getLlmProvider() — no key ⇒ nullProvider
    title.ts                 # prose title with buildTitle() fallback
  storage/{adapter.ts,local.ts}
  engine/
    types.ts                 # Slot, CategorySchema, Condition, SlotValue
    condition.ts             # evaluateCondition() — serializable askIf DSL
    schemas/                 # one file per category (13)
    next-question.ts  completeness.ts  summary.ts  draft.ts
    extract/
      rules.ts               # keyword-only baseline (also the fallback)
      llm.ts                 # pure: JSON schema + prompts + response → SlotValues
      index.ts               # extractFromText() sync rules · extractWithLlm() hybrid
    classify.ts                # slots → facts + dedup signature (pure)
    priority.ts                # the rubric: band + score + reasons[] (pure)
    routing.ts                 # table-driven department + confidence (pure)
  drafts/service.ts          # draft persistence + DraftView for the chat UI
  complaints/assess.ts       # the ONE place classify + priority + routing run
  complaints/create.ts       # persists an assessment + code + CREATED event
  dedup/
    score.ts                 # pure: 0.55 signature · 0.15 location · 0.15 text · 0.15 time
    candidates.ts            # the SQL half — pg_trgm similarity over open incidents
  incidents/
    priority.ts                # pure: max(members) + scale escalation
    message.ts                 # pure: §36 student-facing incident message
    service.ts                 # attach / link / merge / recount
    view.ts                    # one loader for the page and the API
  lifecycle/  transition() + event timeline
  sla/        due dates, breach detection, escalation ladder
  analytics/  raw SQL aggregations, recurring detection, health score
src/proxy.ts                 # Next 16 renamed middleware → proxy
src/worker/index.ts
tests/                       # mirrors src/lib paths
```

## 5. Hard rules

**The LLM never decides.** It does two things only: **extraction** (free text → slot values) and **prose** (summaries, insight narratives). Priority band, department routing, dedup verdicts, and state transitions are deterministic code. This is what makes the "explainable AI" claim true and what keeps the system working without an API key.

- **Everything must work with `GROQ_API_KEY` unset.** Every LLM call needs a rules-based fallback. Re-verify this at every layer, not just Layer 3.
- **Groq:** model `openai/gpt-oss-20b`, `openai` SDK v7 pointed at `api.groq.com/openai/v1`, `temperature: 0`, 4s timeout, 1 retry. `strict: true` JSON schemas require **all properties `required`** + `additionalProperties: false` → use `"unknown"` sentinel values, never optional fields. Strict mode is unsupported on the Llama models.
- **`LlmProvider` methods return `null`, never throw.** Timeout, 429, bad key, malformed JSON, refusal — all become `null`, and the caller runs the rules. Any new LLM call follows this shape.
- **Keyword hints must respect negation.** `hintMatches()` suppresses an option hint negated within three preceding tokens — "nothing sparking or smoking" used to fill `safety_hazard` and submit as CRITICAL. Hints that are themselves negative ("no internet", "cant log in") are exempt. Any new hint list inherits this; check it when adding a category schema.
- **Enum properties in an LLM schema carry a `VALUE = label` legend.** Bare keys made the model choose `MULTI_DAY` for "since yesterday".
- **Never trust an LLM value into a slot.** `mapExtraction()` checks every enum value against the slot's declared options and drops the rest; locations come back as a *phrase* and are resolved by `matchLocation()`. A missing slot costs one question; a wrong slot is shown to the student as fact.
- **Prisma 7:** `prisma-client` generator (not `prisma-client-js`), explicit `output`, mandatory `PrismaPg` adapter. Import from `@/generated/prisma/client`, **never** `@prisma/client`. The connection URL lives in `prisma.config.ts` (`datasource.url`), **not** in `schema.prisma`.
- **Next 16:** middleware is now `src/proxy.ts`; it is only an optimistic cookie check — real authorization is `requireRole()` in layouts/pages and `requireApiRole()` in route handlers.
- **Do not let `create-next-app`/`next dev` own `CLAUDE.md`.** Next writes its managed rules block into `AGENTS.md`; as long as that file hosts the block, `CLAUDE.md` is left alone.
- **Priority, classification and routing are computed in `complaints/assess.ts` and nowhere else.** The pre-submission summary and the submission both call it, which is what makes §12's promise true — the band the student agreed to is the band that gets stored. Never re-derive a priority inline.
- **The rubric takes `safetyShortCircuit` as an input; it does not re-derive live danger.** A schema's `criticalValues` is the single source of truth for "stop asking, this is dangerous" (§3), and passing that signal into `assessPriority()` is what guarantees a halted conversation submits as CRITICAL. Adding a hazard to `CRITICAL_HAZARDS` is for hazards named on a *problem type* rather than a safety slot.
- **`classify.ts` must never match on a category's slot keys or option values.** It reads `slot.signal` (`SCOPE`/`IMPACT`/`DURATION`/`RECURRING`/`PERSON_AT_RISK`) and `option.hazard`. A new category declares those and the rubric scores it with no new code; a new *signal vocabulary value* means updating `classify.ts` and `priority.ts` together.
- **A category's options must not overlap another category's.** Cleaning is SANITATION, taps and drains are WATER, power is ELECTRICAL. Overlapping hints make the keyword classifier flip a coin between them — and the loser is decided by declaration order, which is not a decision. `tests/engine/schemas.test.ts` holds the invariants.
- **Never use scope/impact/duration hints as category evidence.** `extractCategory` skips options on `signal` slots: "my wing" and "since yesterday" describe circumstances every category shares.
- **A band is never returned or displayed without its reasons** (§14). Students see the sentences; staff also see points, details, score, routing confidence and the signature. Routing *uncertainty* is never student-facing (§39) — an unrouted complaint reads "to be assigned by the campus office".
- **Status changes go through `lifecycle/transition()` only.** Never a bare `prisma.complaint.update({ data: { status } })` — it would skip the transition table and the event timeline.
- **Every complaint has exactly one incident.** Size-1 incidents are hidden in the UI (`isSharedIncident()`). No nullable-incident branching anywhere. A merge that empties an incident deletes it — an incident with no members is a leftover, not a record.
- **`affectedCount` is distinct *reporters*, not complaints.** §18 says "47 students have reported this issue"; one student filing twice is one affected student. Always recompute it with `recountIncident()` rather than incrementing.
- **Dedup escalates the incident, never the member.** Linking must not touch a complaint's stored band — the student agreed to that band (§12). Scale (5 → +1, 20 → +2) moves `Incident.priority` only.
- **`dedup/score.ts` stays pure; `dedup/candidates.ts` owns the SQL.** The scorer takes `textSimilarity` as a number so every weight and threshold is a unit test. Candidates are drawn by category + window + open incident — **never** by signature equality, because an `UNKNOWN` scope bucket has to act as a wildcard.
- **A gate that pins a dedup band must pick a sentence the *rules* extractor reads.** "keeps disconnecting" has no keyword hint, so that case only lands on the right subcategory with an API key — which makes the band it asserts accidental. Check the sentence against `extractFromText` before relying on it.
- **`pg_trgm` similarity requires `$queryRaw`** — Prisma has no native trigram support.
- **The domain layer stays pure.** `engine/`, `dedup/`, `sla/`, `analytics/` (except its SQL module) must not import Prisma or call `fetch`. Data in → decisions out. This is the whole reason the layer gates can be unit tests.
- **Do not start a layer until the previous layer's gate passes.** Gates are in `plan.MD` §7.

## 6. Conventions

- Route Handlers over server actions — they're curl-testable, which the gates rely on.
- Zod schema colocated with the route handler that uses it; reuse the same schema for LLM JSON schemas.
- Tests mirror `src/lib` paths under `tests/`.
- Slot keys `snake_case`; category/enum keys `SCREAMING_SNAKE`; complaint codes `CMP-####`, incidents `INC-###` (Postgres sequences `complaint_code_seq` / `incident_code_seq`).
- Priority functions return `{ band, reasons[] }` — never a bare band. §14 requires the reason.

## 7. Layer status

Read this first, update it last. Mirrors `plan.MD`.

| # | Layer | Status |
|---|---|---|
| 0 | Foundation: scaffold, Docker Postgres, Prisma schema, auth, seed | ✅ Gate passed |
| 1 | Static submission (no AI) | ✅ Gate passed |
| 2 | Conversational engine (deterministic) | ✅ Gate passed |
| 3 | LLM extraction adapter (Groq) | ✅ Gate passed |
| 4 | Classification, priority, routing, explainability | ✅ Gate passed |
| 5 | Dedup & incidents | ✅ Gate passed |
| 6 | Lifecycle & staff workflow | ⬜ Next |
| 7 | Attachments & anonymous reporting | ⬜ |
| 8 | SLA & escalation | ⬜ |
| 9 | Resolution confirmation, reopen, feedback | ⬜ |
| 10 | Analytics, dashboards, insights | ⬜ |
| 11 | Search & discovery | ⬜ |
| 12 | AI insight narratives (notifications deferred) | ⬜ |

**Carried into later layers:** incident status is fixed at `OPEN` — propagating it from member complaints is Layer 6's job, and `lib/incidents/view.ts` already derives what that will need. The §36 message text already branches on `RESOLVED`/`CLOSED`.

- auto compact at 60% capacity and after 3 times of auto compacting in a row . make the summary of the session to give to new session
- Do not build until you have 95% confidence of what you are building. To get the confidence ask me for questions.
