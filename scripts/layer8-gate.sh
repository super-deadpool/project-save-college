#!/usr/bin/env bash
# Layer 8 gate: §22's promise and escalation ladder, over the API.
# Needs `npm run dev` on :3000 and a seeded DB.
#
#   scripts/layer8-gate.sh
#
# Submits one complaint as a student, then uses the demo clock to make it older
# than each of its deadlines in turn — the same endpoint a walkthrough uses, so
# what the gate proves is what a demo shows. After each ageing it runs the sweep
# the worker runs every minute and checks:
#
#   · the complaint carries both due dates as soon as it is assigned;
#   · the response breach escalates to the department manager, the resolution
#     breach to the administrator, and twice the resolution window flags it;
#   · the student's feed names what was missed, in words;
#   · a second sweep changes nothing;
#   · the demo clock is refused to a student, and the SLA detail is never in a
#     student's payload (§39).
#
# `scripts/layer8-nokey.ts` covers the same ladder through the service layer and
# adds the reopen case.
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

code_of() {
  curl -sS -o "$WORK/last.json" -w '%{http_code}' -b "$1" -X POST "$BASE$2" \
    -H 'content-type: application/json' -d "$3"
}

echo '── a student reports a problem'
login 'student@campus.edu' "$WORK/student.jar"
login 'admin@campus.edu' "$WORK/admin.jar"
run_case 'The projector in the CSE seminar hall will not switch on.' "$WORK/student.jar" > "$WORK/submit.json"

CID=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["complaint"]["id"])' "$WORK/submit.json")
CODE=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["complaint"]["code"])' "$WORK/submit.json")
DEPT=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["complaint"].get("department") or "")' "$WORK/submit.json")
echo "   $CODE → $DEPT"

case "$DEPT" in
  IT*) MANAGER='manager@campus.edu' ;;
  Maintenance*) MANAGER='manager.mnt@campus.edu' ;;
  *) echo "   FAIL: routed to '$DEPT', which has no seeded manager login"; exit 1 ;;
esac
login "$MANAGER" "$WORK/manager.jar"

# The staff view of the complaint, which is where §22's numbers live.
sla() {
  curl -sS -b "$WORK/manager.jar" "$BASE/api/complaints/$CID" > "$WORK/view.json"
  python3 - "$WORK/view.json" "$@" <<'PY'
import json, sys
view = json.load(open(sys.argv[1]))
sla = view["complaint"]["sla"]
want_level = int(sys.argv[2])
want_risk = sys.argv[3] if len(sys.argv) > 3 else None

print("   %-12s rung %s%s · response due %s · resolution due %s" % (
    sla["risk"],
    sla["escalationLevel"],
    " (flagged)" if sla["flagged"] else "",
    (sla["responseDueAt"] or "—")[:16],
    (sla["resolutionDueAt"] or "—")[:16],
))

fails = []
if sla["escalationLevel"] != want_level:
    fails.append("expected rung %d, got %d" % (want_level, sla["escalationLevel"]))
if want_risk and sla["risk"] != want_risk:
    fails.append("expected risk %s, got %s" % (want_risk, sla["risk"]))
if sla["responseDueAt"] is None or sla["resolutionDueAt"] is None:
    fails.append("a complaint on a department's desk with no deadlines")
for f in fails:
    print("   FAIL: %s" % f)
sys.exit(1 if fails else 0)
PY
}

# How much older the complaint has to be to be past a given deadline. Read from
# the complaint's own due dates rather than hardcoded: the band and the
# department's profile decide the windows, so "70 minutes" would only be the
# right answer for one routing outcome.
minutes_past() {
  curl -sS -b "$WORK/manager.jar" "$BASE/api/complaints/$CID" > "$WORK/now.json"
  python3 - "$WORK/now.json" "$1" <<'PY'
import json, math, sys
from datetime import datetime, timezone

view = json.load(open(sys.argv[1]))
which = sys.argv[2]
c = view["complaint"]
sla = c["sla"]


def at(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


now = datetime.now(timezone.utc)
if which == "response":
    target = at(sla["responseDueAt"])
elif which == "resolution":
    target = at(sla["resolutionDueAt"])
else:  # twice the resolution window, measured from the same start it ran from
    due, created = at(sla["resolutionDueAt"]), at(c["createdAt"])
    target = due + (due - created)

# +2 min so the sweep is unambiguously past it rather than exactly on it.
print(max(1, math.ceil((target - now).total_seconds() / 60) + 2))
PY
}

# Ages the complaint and runs the sweep in one call, then prints what moved.
age() {
  curl -sS -b "$WORK/admin.jar" -X POST "$BASE/api/dev/advance-clock" \
    -H 'content-type: application/json' \
    -d "{\"code\":\"$CODE\",\"minutes\":$1,\"scan\":true}" > "$WORK/aged.json"
  python3 - "$WORK/aged.json" "$CODE" <<'PY'
import json, sys
out = json.load(open(sys.argv[1]))
code = sys.argv[2]
mine = [e for e in out["scan"]["escalated"] if e["code"] == code]
print("   aged by %d min · %d escalated%s" % (
    out["aged"]["minutes"],
    len(out["scan"]["escalated"]),
    "" if not mine else ": %s %d → %d (%s)" % (
        code, mine[0]["from"], mine[0]["to"],
        ", ".join("%s→%s%s" % (s["kind"], s["notify"], " flagged" if s["flagged"] else "") for s in mine[0]["steps"]),
    ),
))
PY
}

echo
echo '── §22: assignment makes the promise'
sla 0 OK

echo
echo '── the response window passes with nobody answering'
age "$(minutes_past response)"
sla 1 BREACHED

echo
echo '── the same sweep again does nothing'
BEFORE=$(python3 -c 'import json,sys;print(len(json.load(open(sys.argv[1]))["updates"]))' "$WORK/view.json")
curl -sS -b "$WORK/admin.jar" -X POST "$BASE/api/dev/sla-scan" > "$WORK/rescan.json"
curl -sS -b "$WORK/manager.jar" "$BASE/api/complaints/$CID" > "$WORK/view2.json"
AFTER=$(python3 -c 'import json,sys;print(len(json.load(open(sys.argv[1]))["updates"]))' "$WORK/view2.json")
echo "   $BEFORE updates before · $AFTER after"
[ "$BEFORE" = "$AFTER" ] || { echo "   FAIL: the rescan wrote duplicate events"; exit 1; }

echo
echo '── the resolution deadline passes, then twice the window'
age "$(minutes_past resolution)"
sla 2 BREACHED
age "$(minutes_past double)"
sla 3 BREACHED

echo
echo '── §20: the student is told what was missed, in words'
curl -sS -b "$WORK/student.jar" "$BASE/api/complaints/$CID" > "$WORK/student-view.json"
python3 - "$WORK/student-view.json" <<'PY'
import json, sys
view = json.load(open(sys.argv[1]))
for u in view["updates"]:
    if "exceeded" in u["headline"] or "Escalated" in u["headline"]:
        print("   %s  %s%s" % (u["at"][11:16], u["headline"], " — " + u["detail"] if u["detail"] else ""))

headlines = [u["headline"] for u in view["updates"]]
fails = []
for wanted in ("Response time exceeded", "Resolution time exceeded", "Twice the resolution time exceeded"):
    if wanted not in headlines:
        fails.append("the feed never says %r" % wanted)
if not any(h.startswith("Escalated to the department manager") for h in headlines):
    fails.append("the feed does not name the manager the complaint went to")
if not any(h.startswith("Escalated to the campus administrator") for h in headlines):
    fails.append("the resolution breach never reached the administrator")
# §39: the student is told when it should be fixed, never the internal risk state.
sla = view["complaint"]["sla"]
if "escalationLevel" in sla or "risk" in sla:
    fails.append("a student's payload carries the internal SLA state")
if "expectedResolutionBy" not in sla:
    fails.append("the student is not told when the fix is expected")
for f in fails:
    print("   FAIL: %s" % f)
sys.exit(1 if fails else 0)
PY

echo
echo '── the demo clock is not a student tool'
FORBIDDEN=$(code_of "$WORK/student.jar" '/api/dev/advance-clock' "{\"code\":\"$CODE\",\"minutes\":10}")
echo "   a student advancing the clock → $FORBIDDEN"
[ "$FORBIDDEN" = '403' ] || { echo "   FAIL: expected 403, got $FORBIDDEN"; exit 1; }

echo
echo 'gate: both deadlines are stamped on assignment, §22 escalates manager → admin → flagged, the sweep is idempotent, and the student sees the words without the internals'
