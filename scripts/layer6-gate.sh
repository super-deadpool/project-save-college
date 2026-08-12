#!/usr/bin/env bash
# Layer 6 gate: the complaint lifecycle and the staff workflow, over the API.
# Needs `npm run dev` on :3000 and a seeded DB.
#
#   scripts/layer6-gate.sh
#
# Submits one complaint as a student, then drives it through §19's whole happy
# path as staff — accept, progress update, question to the student, their answer,
# resolve, close — checking after each move that the student's tracker (§20)
# shows the step with a time against it. Along the way it checks that an illegal
# move, a move by the wrong role, and a move by another department are all
# refused, and that an internal staff note never reaches the student.
#
# `scripts/layer6-nokey.ts` runs the same ground through the service layer with
# no API key and adds the incident-wide action; this script is the API surface.
set -euo pipefail

BASE=${BASE:-http://localhost:3000}
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

login() {
  curl -sS -c "$2" -X POST "$BASE/api/auth/login" \
    -H 'content-type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"password123\"}" > /dev/null
}

# Drives one conversation to submission and echoes the submit response.
run_case() {
  local jar="$2" text="$1"
  local start draft id
  start=$(TEXT="$text" python3 -c 'import json,os;print(json.dumps({"rawText":os.environ["TEXT"]}))')
  draft=$(curl -sS -b "$jar" -X POST "$BASE/api/drafts" -H 'content-type: application/json' -d "$start")
  id=$(python3 -c 'import json,sys;print(json.loads(sys.argv[1])["draft"]["id"])' "$draft")

  for _ in $(seq 1 14); do
    local view body
    view=$(curl -sS -b "$jar" "$BASE/api/drafts/$id")
    body=$(python3 - "$view" <<'PY'
import json, sys
step = json.loads(sys.argv[1])["draft"]["step"]
if step["kind"] == "CATEGORY":
    print(json.dumps({"action": "category", "categoryKey": step["categories"][0]["key"]}))
    sys.exit(0)
if step["kind"] != "QUESTION":
    sys.exit(1)

key, kind = step["slotKey"], step["type"]
opts = [o["value"] for o in step["options"]]
if kind == "location":
    body = {"action": "answer", "slotKey": key, "kind": "UNSURE"}
elif kind == "boolean":
    body = {"action": "answer", "slotKey": key, "kind": "VALUE", "value": False}
elif kind == "multi":
    body = {"action": "answer", "slotKey": key, "kind": "VALUE", "value": ["NONE" if "NONE" in opts else opts[0]]}
elif opts:
    pick = next((p for p in ("TODAY", "NONE") if p in opts), opts[0])
    body = {"action": "answer", "slotKey": key, "kind": "VALUE", "value": pick}
else:
    body = {"action": "answer", "slotKey": key, "kind": "UNSURE"}
print(json.dumps(body))
PY
) || break
    curl -sS -b "$jar" -X POST "$BASE/api/drafts/$id" -H 'content-type: application/json' -d "$body" > /dev/null
  done

  curl -sS -b "$jar" -X POST "$BASE/api/drafts/$id/submit"
}

# HTTP status only, for the calls that are meant to fail.
code_of() {
  curl -sS -o "$WORK/last.json" -w '%{http_code}' -b "$1" -X POST "$BASE$2" \
    -H 'content-type: application/json' -d "$3"
}

echo '── a student reports a problem'
login 'student@campus.edu' "$WORK/student.jar"
run_case 'The projector in the CSE seminar hall will not switch on.' "$WORK/student.jar" > "$WORK/submit.json"

CID=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["complaint"]["id"])' "$WORK/submit.json")
CODE=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["complaint"]["code"])' "$WORK/submit.json")
DEPT=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["complaint"].get("department") or "")' "$WORK/submit.json")
echo "   $CODE → $DEPT"

# Which staff account owns this department. Anything routed away from IT or
# Maintenance is a Layer 4 problem, not a Layer 6 one, so say so plainly.
case "$DEPT" in
  IT*) STAFF='staff@campus.edu'; MANAGER='manager@campus.edu'; OTHER='staff.mnt@campus.edu' ;;
  Maintenance*) STAFF='staff.mnt@campus.edu'; MANAGER='manager.mnt@campus.edu'; OTHER='staff@campus.edu' ;;
  *) echo "   FAIL: routed to '$DEPT', which has no seeded staff login"; exit 1 ;;
esac

track() {
  curl -sS -b "$WORK/student.jar" "$BASE/api/complaints/$CID" > "$WORK/track.json"
  python3 - "$WORK/track.json" "$1" <<'PY'
import json, sys
v = json.load(open(sys.argv[1]))
expected = sys.argv[2]
status = v["complaint"]["status"]
reached = [s for s in v["steps"] if s["state"] != "PENDING"]
missing = [s["label"] for s in reached if not s["at"]]
marks = " ".join(
    ("✓" if s["state"] == "DONE" else "●" if s["state"] == "CURRENT" else "○") + s["label"].split(" to ")[0]
    for s in v["steps"]
)
print("   %-22s %s" % (status, marks))
fails = []
if status != expected:
    fails.append("expected %s, got %s" % (expected, status))
if missing:
    fails.append("reached step(s) with no timestamp: %s" % ", ".join(missing))
for f in fails:
    print("   FAIL: %s" % f)
sys.exit(1 if fails else 0)
PY
}

echo
echo '── §20: analysis and routing are already on the tracker'
track ASSIGNED

echo
echo '── illegal and unauthorised moves are refused'
login "$STAFF" "$WORK/staff.jar"
login "$OTHER" "$WORK/other.jar"

SHORTCUT=$(code_of "$WORK/staff.jar" "/api/complaints/$CID/status" '{"status":"RESOLVED"}')
ALLOWED=$(python3 -c 'import json,sys;print(", ".join(json.load(open(sys.argv[1])).get("allowed",[])))' "$WORK/last.json")
echo "   staff resolving an unaccepted complaint  → $SHORTCUT (allowed: $ALLOWED)"
[ "$SHORTCUT" = '409' ] || { echo "   FAIL: expected 409, got $SHORTCUT"; exit 1; }

BY_STUDENT=$(code_of "$WORK/student.jar" "/api/complaints/$CID/status" '{"status":"ACKNOWLEDGED"}')
echo "   a student accepting their own complaint  → $BY_STUDENT"
[ "$BY_STUDENT" = '403' ] || { echo "   FAIL: expected 403, got $BY_STUDENT"; exit 1; }

CROSS=$(code_of "$WORK/other.jar" "/api/complaints/$CID/status" '{"status":"ACKNOWLEDGED"}')
echo "   another department accepting it          → $CROSS"
[ "$CROSS" = '403' ] || { echo "   FAIL: expected 403, got $CROSS"; exit 1; }

# Two separate refusals: staff may not reject at all, and a manager who may
# still cannot do it silently — the student has to be told why.
BY_STAFF=$(code_of "$WORK/staff.jar" "/api/complaints/$CID/status" '{"status":"REJECTED","note":"not ours"}')
echo "   staff rejecting a complaint              → $BY_STAFF"
[ "$BY_STAFF" = '403' ] || { echo "   FAIL: expected 403, got $BY_STAFF"; exit 1; }

login "$MANAGER" "$WORK/manager.jar"
SILENT=$(code_of "$WORK/manager.jar" "/api/complaints/$CID/status" '{"status":"REJECTED"}')
SILENT_ERR=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("error",""))' "$WORK/last.json")
echo "   a manager rejecting with no reason       → $SILENT ($SILENT_ERR)"
[ "$SILENT" = '409' ] || { echo "   FAIL: expected 409, got $SILENT"; exit 1; }

echo
echo '── §21: the staff workflow, end to end'
curl -sS -b "$WORK/staff.jar" -X POST "$BASE/api/complaints/$CID/assign" \
  -H 'content-type: application/json' -d '{"action":"ACCEPT"}' > /dev/null
track ACKNOWLEDGED

curl -sS -b "$WORK/staff.jar" -X POST "$BASE/api/complaints/$CID/updates" \
  -H 'content-type: application/json' \
  -d '{"kind":"PROGRESS","message":"Lamp module ordered, fitting it this afternoon."}' > /dev/null
track IN_PROGRESS

# An internal note is for the department, not the student (§39).
curl -sS -b "$WORK/staff.jar" -X POST "$BASE/api/complaints/$CID/updates" \
  -H 'content-type: application/json' \
  -d '{"kind":"PROGRESS","message":"Third failure this term on this unit.","isInternal":true}' > /dev/null

curl -sS -b "$WORK/staff.jar" -X POST "$BASE/api/complaints/$CID/updates" \
  -H 'content-type: application/json' \
  -d '{"kind":"INFO_REQUEST","message":"Is the hall free tomorrow morning?"}' > /dev/null
track WAITING_FOR_STUDENT

curl -sS -b "$WORK/student.jar" -X POST "$BASE/api/complaints/$CID/updates" \
  -H 'content-type: application/json' \
  -d '{"kind":"INFO_RESPONSE","message":"Yes, it is free until 11."}' > /dev/null
track IN_PROGRESS

curl -sS -b "$WORK/staff.jar" -X POST "$BASE/api/complaints/$CID/status" \
  -H 'content-type: application/json' -d '{"status":"RESOLVED","note":"Lamp module replaced."}' > /dev/null
track RESOLVED

curl -sS -b "$WORK/student.jar" -X POST "$BASE/api/complaints/$CID/status" \
  -H 'content-type: application/json' -d '{"status":"CLOSED"}' > /dev/null
track CLOSED

echo
echo '── §20: what the student was told, and what they were not'
curl -sS -b "$WORK/student.jar" "$BASE/api/complaints/$CID" > "$WORK/student-view.json"
curl -sS -b "$WORK/staff.jar" "$BASE/api/complaints/$CID" > "$WORK/staff-view.json"

python3 - "$WORK/student-view.json" "$WORK/staff-view.json" <<'PY'
import json, sys
student = json.load(open(sys.argv[1]))
staff = json.load(open(sys.argv[2]))

for u in student["updates"]:
    print("   %s  %s" % (u["at"][11:16], u["headline"]))

fails = []
if any(u["isInternal"] for u in student["updates"]):
    fails.append("an internal staff note reached the student (§39)")
if len(staff["updates"]) <= len(student["updates"]):
    fails.append("the internal note is missing from the staff view too")
headlines = [u["headline"] for u in student["updates"]]
for expected in ("Complaint submitted", "Investigation started", "Marked resolved", "Closed"):
    if expected not in headlines:
        fails.append("the feed never says %r" % expected)
if not any(h.startswith("Assigned to ") for h in headlines):
    fails.append("the feed never names the department it was assigned to (§20)")

c = student["complaint"]
for stamp in ("respondedAt", "resolvedAt", "closedAt"):
    if not c.get(stamp):
        fails.append("%s was never stamped — Layer 8 measures its SLA against it" % stamp)
if not c.get("assignee"):
    fails.append("accepting the complaint did not record who owns it")
if student["actions"]:
    fails.append("the student was handed staff actions")

for f in fails:
    print("   FAIL: %s" % f)
sys.exit(1 if fails else 0)
PY

echo
echo 'gate: the full lifecycle ran over the API, every step is timestamped for the student, and illegal moves were refused'
