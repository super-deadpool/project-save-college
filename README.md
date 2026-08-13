# Smart Complaint Management System

An AI-assisted campus complaint platform. Students report problems through a
conversation instead of a form; the system discovers what information is still
missing, classifies and prioritises the issue, routes it to a department, groups
duplicates into incidents, tracks resolution against SLAs, and turns history into
campus insights.

**The LLM never decides.** It only does extraction (free text → slot values) and
prose (summaries, narratives). Priority bands, routing, duplicate verdicts and
state transitions are deterministic code — which is why the whole system runs
correctly **without an API key**.

- **How it works** — features, system design, algorithms, and what the AI does and does not do: [`ARCHITECTURE.md`](ARCHITECTURE.md)
- Design and layer plan, with every decision and its reasoning: [`plan.MD`](plan.MD)
- Contributor rules and architecture map: [`CLAUDE.md`](CLAUDE.md)

---

## 1. Prerequisites

| Tool | Version | Notes |
|---|---|---|
| **Node.js** | **20.9+** (22 LTS recommended) | Required by Next 16. Check with `node -v`. |
| **npm** | 10+ | Ships with Node. |
| **Docker + Compose** | any current version | Runs Postgres 16 + Adminer. Optional if you already have Postgres 16 — see §3b. |
| **Git** | any | To clone. |
| `bash`, `curl`, `python3` | — | Only needed for the `scripts/*-gate.sh` end-to-end gates. Not needed to run the app. |

You do **not** need a Groq API key. It is optional and only improves extraction
quality (see §6).

### Installing the prerequisites

<details>
<summary><b>macOS</b></summary>

```bash
# Homebrew (https://brew.sh) if you don't have it
brew install node git
brew install --cask docker      # then launch Docker Desktop once so the daemon starts
```

`bash`, `curl` and `python3` are already present on macOS (python3 ships with the
Xcode command line tools — `xcode-select --install` if `python3` is missing).
</details>

<details>
<summary><b>Linux (Debian / Ubuntu)</b></summary>

```bash
# Node 22 via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git curl python3

# Docker Engine + Compose plugin
sudo apt-get install -y docker.io docker-compose-plugin
sudo usermod -aG docker "$USER"   # log out and back in so `docker` works without sudo
```

On Fedora/RHEL substitute `dnf`; on Arch, `pacman -S nodejs npm git docker docker-compose python`.
</details>

<details>
<summary><b>Windows</b></summary>

**Recommended: WSL2.** The gate scripts are bash + `curl` + `python3`, so a Linux
shell saves you a lot of friction.

```powershell
wsl --install -d Ubuntu          # in an elevated PowerShell, then reboot
```

Then follow the **Linux** instructions *inside* the WSL shell, and install
[Docker Desktop](https://www.docker.com/products/docker-desktop/) with the WSL2
backend enabled (Settings → Resources → WSL Integration → enable your distro).
Keep the repo inside the Linux filesystem (`~/skill-up`), not under `/mnt/c` —
file watching and install speed are dramatically better.

**Native Windows** works for everything except the `.sh` gates:

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
winget install Docker.DockerDesktop
```

Use PowerShell for the npm/prisma commands. For the `scripts/*-gate.sh` files use
Git Bash (installed with Git) and make sure `python3` resolves — Git Bash on
Windows often only has `python`, so either install Python from
[python.org](https://www.python.org/downloads/) (which provides `python3`) or run
the gates under WSL.
</details>

---

## 2. Clone and install

```bash
git clone <repo-url> skill-up
cd skill-up
npm install
```

`npm install` runs a `postinstall` hook that executes `prisma generate`, writing
the typed client into `src/generated/prisma/`. That directory is generated — never
edit or read it; import from `@/generated/prisma/client`.

---

## 3. Configure the environment

Copy the example file and edit it:

```bash
cp .env.example .env                    # macOS / Linux / WSL / Git Bash
```

```powershell
Copy-Item .env.example .env             # PowerShell
copy .env.example .env                  # cmd.exe
```

`.env` is git-ignored; `.env.example` is the committed template.

| Variable | Required | Meaning |
|---|---|---|
| `DATABASE_URL` | **yes** | Postgres connection string. Default points at the Docker container on port **5433**. |
| `AUTH_SECRET` | **yes** | Any long random string; signs the JWT session cookie. The app throws on startup if it is unset. |
| `GROQ_API_KEY` | no | Leave blank to run fully on the deterministic engine. |
| `GROQ_MODEL` | no | Defaults to `openai/gpt-oss-20b`. |

Generate a real secret rather than keeping the placeholder:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> The `GROQ_API_KEY` value in `.env.example` is a dead placeholder, not a working
> key. Replace it with your own or blank it out.

### 3a. Start Postgres with Docker (recommended)

```bash
docker compose up -d
```

This starts two containers:

| Service | Host port | What it is |
|---|---|---|
| `scms-db` | **5433** → 5432 | Postgres 16, user/password/db all `scms`. Data persists in the `scms-pgdata` volume. |
| `scms-adminer` | **8080** | Web DB browser. Log in with server `db`, user `scms`, password `scms`, database `scms`. |

Port **5433** is deliberate — it avoids clashing with a Postgres you may already
run locally on 5432.

Check it is healthy before migrating:

```bash
docker compose ps          # scms-db should read "healthy"
```

### 3b. Or use an existing Postgres

Postgres **16** or newer. Create the database and point `DATABASE_URL` at it:

```sql
CREATE DATABASE scms;
```

```dotenv
DATABASE_URL="postgresql://USER:PASSWORD@localhost:5432/scms?schema=public"
```

The first migration runs `CREATE EXTENSION IF NOT EXISTS pg_trgm`, which requires
a superuser (or a role with `CREATE` on the database and the extension
allow-listed). Trigram similarity is what duplicate detection and search are built
on, so this is not optional. If your role cannot create extensions, have a DBA run:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

---

## 4. Create the schema and seed

```bash
npm run db:migrate      # prisma migrate dev — applies the 4 migrations
npm run db:seed         # departments, locations, routing rules, SLA profiles, demo users
```

Both commands read `DATABASE_URL` through `prisma.config.ts` (Prisma 7 moved the
URL out of `schema.prisma`).

To wipe and rebuild from scratch at any time:

```bash
npm run db:reset        # drops, re-migrates, re-seeds
```

Inspect the data with either `npm run db:studio` (Prisma Studio, opens :5555) or
Adminer at <http://localhost:8080>.

### Demo logins

All use the password **`password123`**:

| Email | Role | Department |
|---|---|---|
| `student@campus.edu` | Student | — |
| `student2@campus.edu`, `student3@campus.edu`, `student4@campus.edu` | Students | — |
| `staff@campus.edu` | Staff | IT |
| `staff.mnt@campus.edu` | Staff | Maintenance |
| `manager@campus.edu` | Dept. manager | IT |
| `manager.mnt@campus.edu` | Dept. manager | Maintenance |
| `admin@campus.edu` | Admin | — |

---

## 5. Run it

Two processes. Open two terminals:

```bash
npm run dev             # the app → http://localhost:3000
```

```bash
npm run worker          # background jobs: SLA sweep every minute, recurrence scan nightly
npm run worker -- --once    # a single sweep of each job, then exit
```

The worker is what escalates breached SLAs and detects recurring trends. The app
works without it; those two behaviours just never fire.

Then open <http://localhost:3000> and log in.

### Where to look

| Route | Who | What |
|---|---|---|
| `/report` | Student | The conversational intake — the heart of the system |
| `/report/form` | Student | The plain form fallback |
| `/complaints` | Student | Their complaints; confirm or reject a resolution, rate it |
| `/complaints/[id]` | Anyone with access | Status tracker, timeline, priority reasons |
| `/queue` | Staff / manager | The prioritised work queue |
| `/incidents/[id]` | Staff / manager | A group of duplicate reports, acted on as one |
| `/dashboard` | Manager → department view · Admin → campus view | Analytics, heatmaps, health score, insights |

### Production build

```bash
npm run build
npm start               # serves the built app on :3000
```

The `/api/dev/*` endpoints below are disabled when `NODE_ENV=production`.

---

## 6. Running without a Groq key

Leave `GROQ_API_KEY` blank. Every LLM call has a rules-based fallback, and
`LlmProvider` returns `null` rather than throwing on any failure — timeout, bad
key, rate limit, malformed JSON. With no key the system uses the keyword
extractor: it asks a few more questions, and titles are built rather than written,
but nothing is disabled and every band, route and verdict is identical.

With a key set (`GROQ_API_KEY=gsk_...`), free-text extraction pre-fills more slots
so the conversation is shorter. Get one at <https://console.groq.com>.

---

## 7. Tests and layer gates

The unit suite is pure and needs no database, no server and no API key:

```bash
npm test                # vitest — 414 tests across 24 files
npm run test:watch
```

Each layer also has a gate. The `*-nokey.ts` scripts drive the service layer
directly and need only a **seeded database**; the `*-gate.sh` scripts drive the
**HTTP API** and need `npm run dev` running as well.

```bash
# no-key gates — DB only
GROQ_API_KEY= npx tsx scripts/layer5-nokey.ts    # dedup & incidents
GROQ_API_KEY= npx tsx scripts/layer6-nokey.ts    # lifecycle & staff workflow
GROQ_API_KEY= npx tsx scripts/layer8-nokey.ts    # SLA escalation ladder
GROQ_API_KEY= npx tsx scripts/layer9-nokey.ts    # resolution confirm / reopen / rating
GROQ_API_KEY= npx tsx scripts/layer10-nokey.ts   # recounts every analytics aggregate

# API gates — need `npm run dev` in another terminal
./scripts/layer3-gate.sh      # draft → submit, end to end
./scripts/layer4-gate.sh      # priority + reasons + department, shown vs stored
./scripts/layer5-gate.sh      # incident RBAC   ⚠ flaky, see CLAUDE.md
./scripts/layer6-gate.sh      # lifecycle over the API, plus the refusals
./scripts/layer8-gate.sh      # the SLA ladder, driven by the demo clock
./scripts/layer9-gate.sh      # feedback over the API, plus the refusals
./scripts/layer10-gate.sh     # role-scoped dashboards, page vs API agreement

# side-by-side comparison of the rules and LLM extractors on the same sentences
npx tsx scripts/layer3-compare.ts
```

On Windows, run the `.sh` gates from **WSL** or **Git Bash** — they are bash and
use `curl` and `python3`. If a script is not executable:

```bash
chmod +x scripts/*.sh
# or run it as: bash scripts/layer3-gate.sh
```

Every gate prints its failures last and exits non-zero, so reading the tail of the
output is enough.

### Demoing the SLA ladder without waiting

Dev only, admin only. Log in as `admin@campus.edu` to get a cookie jar, then age a
complaint past its deadlines and run the sweep in one call:

```bash
curl -sS -c jar -X POST localhost:3000/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@campus.edu","password":"password123"}'

curl -sS -b jar -X POST localhost:3000/api/dev/advance-clock \
  -H 'content-type: application/json' \
  -d '{"code":"CMP-0042","minutes":180,"scan":true}'

curl -sS -b jar -X POST localhost:3000/api/dev/sla-scan     # the sweep on its own
```

---

## 8. Ports

| Port | Service | Change it by |
|---|---|---|
| **3000** | Next.js app | `npm run dev -- -p 3001` (also update `BASE` when running gates: `BASE=http://localhost:3001 ./scripts/layer3-gate.sh`) |
| **5433** | Postgres (host side) | Edit the `ports:` mapping in `docker-compose.yml` **and** `DATABASE_URL` |
| **8080** | Adminer | Edit `docker-compose.yml` |
| **5555** | Prisma Studio | `npx prisma studio --port 5556` |

---

## 9. Troubleshooting

**`AUTH_SECRET is not set`** — `.env` is missing or empty. See §3.

**`Can't reach database server at localhost:5433`** — Docker isn't running, or the
container isn't up. `docker compose up -d` then `docker compose ps` and confirm
`scms-db` is `healthy`. On Windows make sure Docker Desktop is actually started.

**Port 5433 already in use** — something else claims it. Change the host side of
the mapping in `docker-compose.yml` (e.g. `"5434:5432"`) and update `DATABASE_URL`
to match.

**Port 3000 already in use** — `npm run dev -- -p 3001`.

**`Cannot find module '@/generated/prisma/client'`** — the client wasn't generated.
Run `npx prisma generate` (or reinstall — `postinstall` does it).

**`type "pg_trgm" does not exist` / extension errors on migrate** — your Postgres
role can't create extensions. See §3b.

**Migration drift / "database schema is not empty"** — `npm run db:reset` (this
destroys all data, then re-seeds).

**Gates fail with connection refused** — the `.sh` gates need `npm run dev`
running. The `-nokey.ts` gates don't.

**`python3: command not found` on Windows** — Git Bash exposes `python`, not
`python3`. Install Python from python.org or run the gates under WSL.

**Docker permission denied on Linux** — you aren't in the `docker` group.
`sudo usermod -aG docker "$USER"`, then log out and back in.

**The dashboards look empty, and no recurring trends appear** — expected. There is
no demo seed, so every complaint in the database was filed by a gate script inside
a single month. The recurrence detector deliberately refuses to call the start of
the data a trend, and resolution times are near zero because the gates resolve
complaints seconds after filing them. This is a property of the data, not a bug —
see the note at the end of `CLAUDE.md` §7.

---

## 10. Layer status

| # | Layer | Status |
|---|---|---|
| 0 | Foundation: scaffold, Docker Postgres, Prisma schema, auth, seed | ✅ |
| 1 | Static submission (no AI) | ✅ |
| 2 | Conversational engine (deterministic) | ✅ |
| 3 | LLM extraction adapter (Groq) | ✅ |
| 4 | Classification, priority, routing, explainability | ✅ |
| 5 | Dedup & incidents | ✅ |
| 6 | Lifecycle & staff workflow | ✅ |
| 7 | Attachments & anonymous reporting | ⬜ Dropped — additive, nothing depends on it |
| 8 | SLA & escalation | ✅ |
| 9 | Resolution confirmation, reopen, feedback | ✅ |
| 10 | Analytics, dashboards, insights | ✅ |
| 11 | Search & discovery | ⬜ Next |
| 12 | AI insight narratives | ⬜ |

Notifications (§35/§36) are deferred. The `ESCALATED` events already carry the
recipient's id and name, so delivery is the only missing half.

---

## 11. Tech stack

Next.js 16 (App Router, Route Handlers, `src/proxy.ts` instead of middleware) ·
React 19 · TypeScript · Tailwind 4 · Prisma 7 with the `PrismaPg` driver adapter ·
Postgres 16 with `pg_trgm` · `jose` for JWT sessions · `bcryptjs` · Zod 4 ·
`node-cron` for the worker · Groq via the OpenAI SDK v7 · Vitest.
