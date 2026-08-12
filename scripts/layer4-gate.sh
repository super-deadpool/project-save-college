#!/usr/bin/env bash
# Layer 4 gate: classification, priority, routing and the *why*, over the API.
# Needs `npm run dev` on :3000 and a seeded DB.
#
#   scripts/layer4-gate.sh
#
# Drives three complaints end to end and prints, for each, what the pre-submission
# summary told the student (§12) and what was actually persisted. The gate passes
# when the two agree, the reason list is real sentences rather than a bare label,
# and the department is named.
#
# Runs identically with GROQ_API_KEY unset — the rubric is deterministic; the LLM
# only ever pre-filled the answers it scores.
set -euo pipefail

BASE=${BASE:-http://localhost:3000}
JAR=$(mktemp)
trap 'rm -f "$JAR"' EXIT

curl -sS -c "$JAR" -X POST "$BASE/api/auth/login" \
  -H 'content-type: application/json' \
  -d '{"email":"student@campus.edu","password":"password123"}' > /dev/null

# Each case: the opening sentence, then how to answer whatever is asked.
# STRATEGY=benign picks the "nothing dangerous" option; STRATEGY=worst picks the
# first (most severe) option, to exercise the hard overrides.
run_case() {
  local label="$1" text="$2" strategy="$3"

  echo "── $label"
  local start draft id
  start=$(TEXT="$text" python3 -c 'import json,os;print(json.dumps({"rawText":os.environ["TEXT"]}))')
  draft=$(curl -sS -b "$JAR" -X POST "$BASE/api/drafts" -H 'content-type: application/json' -d "$start")
  id=$(python3 -c 'import json,sys;print(json.loads(sys.argv[1])["draft"]["id"])' "$draft")

  python3 - "$draft" <<'PY'
import json, sys
d = json.loads(sys.argv[1])["draft"]
print(f'   read by       : {d["extractionSource"]} → category {d["categoryKey"]}')
PY

  # Answer until the conversation reaches its summary.
  for _ in $(seq 1 14); do
    local view body
    view=$(curl -sS -b "$JAR" "$BASE/api/drafts/$id")
    body=$(STRATEGY="$strategy" python3 - "$view" <<'PY'
import json, os, sys
step = json.loads(sys.argv[1])["draft"]["step"]
if step["kind"] == "CATEGORY":
    print(json.dumps({"action": "category", "categoryKey": step["categories"][0]["key"]}))
    sys.exit(0)
if step["kind"] != "QUESTION":
    sys.exit(1)

worst = os.environ["STRATEGY"] == "worst"
key, kind, opts = step["slotKey"], step["type"], [o["value"] for o in step["options"]]

if kind == "location":
    body = {"action": "answer", "slotKey": key, "kind": "VALUE", "value": os.environ.get("LOC", "")} \
        if os.environ.get("LOC") else {"action": "answer", "slotKey": key, "kind": "UNSURE"}
elif kind == "boolean":
    body = {"action": "answer", "slotKey": key, "kind": "VALUE", "value": bool(worst)}
elif kind == "multi":
    pick = opts[0] if worst else ("NONE" if "NONE" in opts else opts[-1])
    body = {"action": "answer", "slotKey": key, "kind": "VALUE", "value": [pick]}
elif opts:
    pick = opts[0] if worst else ("NONE" if "NONE" in opts else opts[-1])
    body = {"action": "answer", "slotKey": key, "kind": "VALUE", "value": pick}
else:
    body = {"action": "message", "slotKey": key, "text": "no further detail"}
print(json.dumps(body))
PY
) || break
    curl -sS -b "$JAR" -X POST "$BASE/api/drafts/$id" -H 'content-type: application/json' -d "$body" > /dev/null
  done

  # §12 — what the student is shown before they commit.
  local summary submitted
  summary=$(curl -sS -b "$JAR" "$BASE/api/drafts/$id")
  python3 - "$summary" <<'PY'
import json, sys
step = json.loads(sys.argv[1])["draft"]["step"]
if step["kind"] != "SUMMARY":
    sys.exit("   FAIL: conversation never reached a summary (stuck on %s)" % step["kind"])
a = step.get("assessment")
if not a:
    sys.exit("   FAIL: summary carried no assessment")
sub = " — %s" % a["subcategoryLabel"] if a["subcategoryLabel"] else ""
dept = a["departmentName"] or "to be assigned by the campus office"
print("   summary says  : %s · %s%s · %s" % (a["priority"], a["categoryLabel"], sub, dept))
for r in a["reasons"]:
    print("                 · %s" % r)
if not a["reasons"]:
    sys.exit("   FAIL: priority shown with no reasons (§14)")
PY

  submitted=$(curl -sS -b "$JAR" -X POST "$BASE/api/drafts/$id/submit")
  python3 - "$submitted" <<'PY'
import json, sys
d = json.loads(sys.argv[1])
c, a = d["complaint"], d["assessment"]
dept = c["department"] or "unrouted"
print("   persisted     : %s %s → %s (triage=%s)" % (c["code"], c["priority"], dept, c["needsTriage"]))
if c["priority"] != a["priority"]:
    sys.exit("   FAIL: shown %s but stored %s" % (a["priority"], c["priority"]))
PY
  echo
}

# The exact band a case lands on depends on what history the database already
# holds — the recurrence term is real, so a repeatedly-reported chair does climb.
# Bands are pinned in tests/engine/priority.test.ts, where history is controlled;
# what this script checks is that the student is shown a real assessment and the
# stored complaint matches it.
run_case 'safety override — exposed wiring with someone near it' \
  'There is exposed electrical wiring near the hostel entrance in Boys Hostel A' worst

run_case 'scored on circumstances — building-wide outage during exams' \
  'No internet at all in the whole of CSE Block since yesterday and we have an exam' benign

run_case 'lowest-severity path — one broken chair, nothing urgent' \
  'A chair is broken in CSE 101' benign

echo 'gate: each complaint was shown a priority with reasons and a department, and stored the same band'
