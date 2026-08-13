# CLAUDE.md

## 1. What this is

Smart Complaint Management System — an AI-assisted campus complaint platform. Students report problems through a conversation instead of a form; the system discovers what information it still needs, classifies and prioritises the issue, routes it to a department, groups duplicates into incidents, tracks resolution, and turns history into campus insights.

Core idea (spec §1): **don't make the student know what information is required — make the system discover it.**

- **Design + layer plan:** `plan.MD` ← read this, not the spec
- **Current layer:** see §7 below
- **Deferred:** notifications (§35/§36); no embeddings/pgvector
- **Dropped:** Layer 7 (attachments, anonymous reporting) and `prisma/seed-demo.ts` — both deliberate, both recorded in `plan.MD`

## 2. Read this, not that (token discipline)

| Don't | Do |
|---|---|
| Read `smart_complaint_management_system.md` in full (24KB requirements doc) | Read `plan.MD` §3–§6 — every design decision derived from the spec is already encoded there. `grep` the spec for a `§` number only when implementing that specific feature. |
| Read `src/generated/prisma/**` | It's generated and huge. Types come from imports. |
| Read `prisma/migrations/**` SQL to learn the schema | Read `prisma/schema.prisma` |
| Read all 13 files in `src/lib/engine/schemas/` | `grep` for the slot key or category key. Shared slots (scope/impact/duration/recurring/location/details/person-at-risk/health-impact) live in `schemas/shared.ts` — check there before adding one. |
| Pipe a gate script's full output through context | Run it and read the tail — every gate prints its failures last and exits non-zero |
| Re-derive a settled decision | It's in `plan.MD` §1 or §8 with the reasoning |

Prefer `grep`/`rg` over reading whole files. When a task spans many files, delegate the sweep and keep the conclusion.

## 3. Commands

```bash
docker compose up -d        # Postgres + Adminer
npm run dev                 # app        → :3000
npm run worker              # node-cron: SLA sweep every minute, recurrence scan nightly
npm run worker -- --once    # one sweep of each job, then exit — what the gates use
npm run db:migrate          # prisma migrate dev
npm run db:seed             # departments, locations, routing rules, SLA profiles, demo users
npm run db:studio
npm test                    # vitest — the layer gates

./scripts/layer3-gate.sh              # end-to-end draft→submit over the API (needs npm run dev)
npx tsx scripts/layer3-compare.ts     # rules vs LLM on the same sentences, same engine
./scripts/layer4-gate.sh              # priority + why + department, shown vs stored (needs npm run dev)
GROQ_API_KEY= npx tsx scripts/layer4-nokey.ts   # the no-key run, through the service layer

GROQ_API_KEY= npx tsx scripts/layer5-nokey.ts   # the Layer 5 gate — isolates its own history, asserts exact counts
./scripts/layer5-gate.sh              # §16 from four real logins + incident RBAC (needs npm run dev)
                                      #   ⚠ flaky: §16's 4th student depends on LLM extraction, and it does not
                                      #   isolate its run, so it can pass on a leftover incident. Trust the
                                      #   no-key script above; see plan.MD, Layer 5.

GROQ_API_KEY= npx tsx scripts/layer6-nokey.ts   # the Layer 6 gate — full §19 path + the incident-wide action
./scripts/layer6-gate.sh              # the same over the API, plus the four refusals (needs npm run dev)
npx tsx scripts/layer6-backfill.ts    # one-off: give pre-Layer-6 complaints a lifecycle (idempotent)

GROQ_API_KEY= npx tsx scripts/layer8-nokey.ts    # §22's ladder: due dates → manager → admin → flagged
./scripts/layer8-gate.sh              # the same over the API, driven by the demo clock (needs npm run dev)

GROQ_API_KEY= npx tsx scripts/layer9-nokey.ts    # §23/§24 both ways: declined then confirmed, rated once
./scripts/layer9-gate.sh              # the same over the API, plus the five refusals (needs npm run dev)

GROQ_API_KEY= npx tsx scripts/layer10-nokey.ts   # recounts every aggregate; drives §27→§30 over a temp trend
./scripts/layer10-gate.sh             # role-scoped dashboards, page-vs-API agreement (needs npm run dev)
```

Demo the SLA ladder without waiting (dev only, admin only):

```bash
# make CMP-0042 older than its deadlines and run the sweep in one call
curl -sS -b jar -X POST localhost:3000/api/dev/advance-clock \
  -H 'content-type: application/json' -d '{"code":"CMP-0042","minutes":180,"scan":true}'
curl -sS -b jar -X POST localhost:3000/api/dev/sla-scan     # the sweep on its own
```

Ports: app **3000** · Postgres **5433** (not 5432 — avoids clashing with a local instance) · Adminer **8080**

Env: `DATABASE_URL`, `AUTH_SECRET`, `GROQ_API_KEY` (optional), `GROQ_MODEL` (default `openai/gpt-oss-20b`). See `.env.example`.

Demo logins (all `password123`): `student@campus.edu` · `staff@campus.edu` (IT) · `staff.mnt@campus.edu` (Maintenance) · `manager@campus.edu` · `admin@campus.edu`.

## 4. Architecture map

```
src/app/
  login/  report/  complaints/[id]/  queue/  incidents/[id]/
  dashboard/                 # one route, two views: campus (§31) or department (§32) by role
  api/{auth,drafts,complaints,incidents,analytics,dev}/   # Route Handlers
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
  complaints/create.ts       # persists an assessment, then walks it to ASSIGNED
  complaints/access.ts       # who may *act* on a complaint (404 vs 403)
  dedup/
    score.ts                 # pure: 0.55 signature · 0.15 location · 0.15 text · 0.15 time
    candidates.ts            # the SQL half — pg_trgm similarity over open incidents
  incidents/
    priority.ts                # pure: max(members) + scale escalation
    status.ts                  # pure: member statuses → IncidentStatus + reason
    message.ts                 # pure: §36 student-facing incident message
    service.ts                 # attach / link / merge / recount / syncIncidentStatus
    actions.ts                 # §17: one status applied to every member
    view.ts                    # one loader for the page and the API
  lifecycle/
    machine.ts                 # pure: the §19 transition table, canTransition, pathTo
    stepper.ts                 # pure: §20's tracker — status + stamps → steps
    timeline.ts                # pure: event → headline/detail; statusStamps()
    transition.ts              # the ONE writer of Complaint.status + its events
  queue/rank.ts                # pure: §21 ordering + slaRisk(), null-safe on missing due dates
  sla/
    due.ts                     # pure: profile + band + start → the two deadlines
    breach.ts                  # pure: §22's ladder — what is late, which rung, who it goes to
    service.ts                 # the impure half: stamps due dates, runs the escalation sweep
    dev-clock.ts               # dev only: ages a complaint so a breach can be demoed
  feedback/
    satisfaction.ts            # pure: rating validity, averages, the 0..1 form §34 wants
    service.ts                 # §23 confirm/reject + §24 rating (the routes are thin over this)
  analytics/
    recurring.ts               # pure: §27 growth detection + §30 suggestions
    heatmap.ts                 # pure: §28 density → High/Medium/Low, relative to the busiest
    health.ts                  # pure: §34's formula, returning its terms
    format.ts                  # pure: how a figure is spoken — "—" not "0%"
    sql.ts                     # every $queryRaw aggregation (the designated impure module)
    service.ts                 # composes both dashboards; the pages and the API share it
src/components/charts.tsx      # server-rendered SVG/CSS charts, no client JS
src/proxy.ts                 # Next 16 renamed middleware → proxy
src/worker/index.ts          # node-cron: SLA sweep (§22) + nightly recurrence scan (§30)
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
- **Status changes go through `lifecycle/transition()` only.** Never a bare `prisma.complaint.update({ data: { status } })` — it would skip the transition table and the event timeline. `transition()` also owns the `respondedAt`/`resolvedAt`/`closedAt` stamps and `reopenCount`; nothing else writes them.
- **`lifecycle/machine.ts` is the whole truth about legality, and it has no shortcut edges.** `ASSIGNED → IN_PROGRESS` is deliberately absent: `respondedAt` is stamped on `ACKNOWLEDGED` and Layer 8 measures its response SLA against it, so a shortcut would leave a worked-on complaint with no response time. Anything that needs to cross several rungs uses `pathTo()` and takes them one at a time.
- **`pathTo()` is for the incident-wide action, never for a single complaint.** A complaint's buttons come from `nextStatuses()`, where the ladder's strictness is the point. Bulk resolve walks, because forty members sit at forty different rungs. Intermediate steps may never be ones that `requiresNote` — nobody is carried *through* "rejected" en route somewhere else.
- **A rule's `narration` is what the feed says, not the enum.** §20 reads "Investigation started" and "Assigned to IT Services". A new transition without a narration would surface a raw enum to a student.
- **`Incident.status` is derived, never written by hand.** `recountIncident()` recomputes it from the members on every transition: active if **any** member is being worked on, resolved only if **every** one is. Writing it directly would make the two directions of §17 disagree.
- **Submission walks the first two steps.** `createComplaint` runs SUBMITTED → ANALYZING → ASSIGNED through `transition()` because the analysis really has already happened. A complaint routing could not place stops at ANALYZING — that is §15's human decision, and pretending it was assigned would hide it.
- **Load `ComplaintEvent` ordered by `[createdAt, id]`.** Submission writes three events inside one millisecond and Prisma's `DateTime` only stores milliseconds; cuid v1 sorts by creation time, so the id is the tiebreak that keeps the feed in the order things happened.
- **The §21 queue ordering is a pure function over nullable due dates.** `queue/rank.ts` must keep working before Layer 8 stamps `responseDueAt`/`resolutionDueAt` — no dates means the at-risk bucket never fires and the order degrades to band → score → age.
- **Every complaint has exactly one incident.** Size-1 incidents are hidden in the UI (`isSharedIncident()`). No nullable-incident branching anywhere. A merge that empties an incident deletes it — an incident with no members is a leftover, not a record.
- **`affectedCount` is distinct *reporters*, not complaints.** §18 says "47 students have reported this issue"; one student filing twice is one affected student. Always recompute it with `recountIncident()` rather than incrementing.
- **Dedup escalates the incident, never the member.** Linking must not touch a complaint's stored band — the student agreed to that band (§12). Scale (5 → +1, 20 → +2) moves `Incident.priority` only.
- **`transition()` owns the SLA clock as well as the stamps.** Entering ASSIGNED (re)starts both due dates from the department's `SlaProfile`; ACKNOWLEDGED/IN_PROGRESS only fill a gap; REOPENED clears the due dates, `respondedAt` and `escalationLevel`, because §23's reopen is a fresh promise on a second attempt. Never stamp a due date anywhere else.
- **The escalation sweep only ever moves a complaint *up* §22's ladder.** `escalationLevel` is the record of the rung reached, and that is what makes the once-a-minute cron, the dev endpoint and the gate all safe to run against the same complaint. A rung is walked only when *its own* breach is true (`escalationPlan`), so a complaint answered on time never gets a "nobody responded" event on its way to the admin. `escalationLevel >= 3` **is** §22's "flagged" — do not add a column for it.
- **`sla/due.ts` and `sla/breach.ts` stay pure; `sla/service.ts` owns the Prisma** — the same split as `dedup/`. A threshold or a ladder rung that lives in `service.ts` cannot be unit-tested, which is the whole point of Layer 8's gate being a pure test plus one script.
- **"Late" is defined twice and must agree.** `sla/breach.ts` decides it per row (the escalation ladder, the badges); the `BREACHED` fragment in `analytics/sql.ts` decides it in aggregate (SLA compliance, health). `scripts/layer10-nokey.ts` recounts one against the other — if you change either definition, change both and rerun that gate.
- **§23 and §24 belong to the reporter.** `feedback/service.ts` compares against `reporterId`, not a role: an admin can *see* a complaint without being the person it happened to. Staff are also not offered a "Close" button on a RESOLVED complaint, even though the table permits it — legality and whose decision it is are different questions. One `Feedback` row per complaint, or the campus average becomes a click count.
- **`analytics/` is pure except `sql.ts`.** `recurring.ts`, `heatmap.ts`, `health.ts` and `format.ts` take rows and return decisions; `sql.ts` holds every `$queryRaw`; `service.ts` composes them and is the **only** thing the pages and `/api/analytics/overview` call — a number on a dashboard must be a number the API can be asked for.
- **§34's score is never returned bare.** `healthScore()` returns five signed terms with the measurement behind each, and every surface prints them. Same rule as §14's priority reasons.
- **§27 needs a baseline, not just growth.** The detector requires sustained volume, a live latest month, *and* either a non-zero first month or three active months. Real data broke this: with all history inside one month it reported "up 5200% since March" against months that predate the system. Where there is no baseline the signal says "up from none" and `hasBaseline` is false — never format `growthRate` as a percentage without checking it.
- **Charts plot one series and never rely on colour alone.** `components/charts.tsx` is server-rendered CSS/SVG with no client JS: one blue for magnitude, the four reserved status colours only for states, every band printed as a word beside its swatch, and a `title` on every mark. Two of the three status steps are below 3:1 on white — the word is what carries the meaning.
- **`dedup/score.ts` stays pure; `dedup/candidates.ts` owns the SQL.** The scorer takes `textSimilarity` as a number so every weight and threshold is a unit test. Candidates are drawn by category + window + open incident — **never** by signature equality, because an `UNKNOWN` scope bucket has to act as a wildcard.
- **A gate that pins a dedup band must pick a sentence the *rules* extractor reads.** "keeps disconnecting" has no keyword hint, so that case only lands on the right subcategory with an API key — which makes the band it asserts accidental. Check the sentence against `extractFromText` before relying on it.
- **`pg_trgm` similarity requires `$queryRaw`** — Prisma has no native trigram support.
- **The domain layer stays pure.** `engine/`, `dedup/`, `sla/`, `feedback/` and `analytics/` must not import Prisma or call `fetch` — **except** each area's one designated impure module: `dedup/candidates.ts`, `sla/service.ts`, `feedback/service.ts`, `analytics/sql.ts` (+ `analytics/service.ts`, which only composes). Data in → decisions out. This is the whole reason the layer gates can be unit tests.
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
| 6 | Lifecycle & staff workflow | ✅ Gate passed |
| 7 | Attachments & anonymous reporting | ⬜ **Dropped** — additive, nothing depends on it |
| 8 | SLA & escalation | ✅ Gate passed |
| 9 | Resolution confirmation, reopen, feedback | ✅ Gate passed |
| 10 | Analytics, dashboards, insights | ✅ Gate passed — **no demo seed**, see below |
| 11 | Search & discovery | ⬜ Next |
| 12 | AI insight narratives (notifications deferred) | ⬜ |

**Where the sparse data bites.** With `seed-demo.ts` dropped, every complaint in the database was filed by a gate script, inside one month. The dashboards are correct but thin, and two things follow: §27's recurrence detector will report nothing in the running app (it refuses to call the start of the data a trend — see §5), and average resolution times are near zero because the gates resolve complaints seconds after filing them. Both are properties of the data, not of the code: `scripts/layer10-nokey.ts` recounts every aggregate against the row-level modules and drives §27 → §30 over a four-month trend it creates and deletes. If you want a populated walkthrough, seeding history is the missing piece — not fixing analytics.

**Carried into Layer 11–12:** the search layer has what it needs — `pg_trgm` GIN indexes on `title`/`description` exist from Layer 0, and §38's "complaints that have exceeded their resolution time" is the `BREACHED` fragment in `analytics/sql.ts` used as a filter rather than a count. Layer 12's weekly summary should compute its numbers with the existing `analytics/sql.ts` functions and hand *only the prose* to Groq, with `RecurringSignal.narrative` as the no-key fallback it already writes. Notifications (§35/§36) stay deferred; the `ESCALATED` events already carry the recipient's id and name in `meta`, so delivery is the only missing half.

- auto compact at 60% capacity and after 3 times of auto compacting in a row . make the summary of the session to give to new session
- Do not build until you have 95% confidence of what you are building. To get the confidence ask me for questions.
