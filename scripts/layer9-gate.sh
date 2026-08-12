#!/usr/bin/env bash
# Layer 9 gate: §23's resolution confirmation and §24's rating, over the API.
# Needs `npm run dev` on :3000 and a seeded DB.
#
#   scripts/layer9-gate.sh
#
# Two complaints, because §23 has two answers:
#
#   A  resolved → the student says it is NOT fixed → REOPENED with their reason,
#      a fresh SLA promise, reopenCount 1, and the department sees it again;
#      then resolved a second time → confirmed → CLOSED → rated.
#   B  resolved → confirmed straight away → CLOSED → rated 5 with a comment.
#
# Plus the refusals that make the two questions the student's own: staff cannot
# confirm on their behalf, a stranger cannot rate someone else's complaint,
# nothing can be rated before it is resolved, and nothing can be rated twice.
set -euo pipefail

BASE=${BASE:-http://localhost:3000}
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

login() {
  curl -sS -c "$2" -X POST "$BASE/api/auth/login" \
    -H 'content-type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"password123\"}" > /dev/null
}

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

# Everything the student is shown or asked about one complaint.
view() {
  curl -sS -b "$WORK/student.jar" "$BASE/api/complaints/$1" > "$WORK/view.json"
  python3 - "$WORK/view.json" "$2" "${3:-}" <<'PY'
import json, sys
v = json.load(open(sys.argv[1]))
c, asks = v["complaint"], v["asks"]
expected, want = sys.argv[2], sys.argv[3]

print("   %-10s reopened %d · asks: %s%s · rating %s" % (
    c["status"],
    c["reopenCount"],
    "confirm" if asks["confirmResolution"] else ("rate" if asks["rateResolution"] else "nothing"),
    "",
    c["feedback"]["rating"] if c["feedback"] else "—",
))

fails = []
if c["status"] != expected:
    fails.append("expected %s, got %s" % (expected, c["status"]))
if want == "confirm" and not asks["confirmResolution"]:
    fails.append("the student is not being asked whether it was fixed (§23)")
if want == "rate" and not asks["rateResolution"]:
    fails.append("the student is not being asked for a rating (§24)")
if want == "nothing" and (asks["confirmResolution"] or asks["rateResolution"]):
    fails.append("the student is being asked something they have already answered")
for f in fails:
    print("   FAIL: %s" % f)
sys.exit(1 if fails else 0)
PY
}

# Drives one complaint from submission to RESOLVED as its department's staff.
resolve() {
  local cid="$1" jar="$2" note="$3"
  curl -sS -b "$jar" -X POST "$BASE/api/complaints/$cid/assign" \
    -H 'content-type: application/json' -d '{"action":"ACCEPT"}' > /dev/null
  curl -sS -b "$jar" -X POST "$BASE/api/complaints/$cid/status" \
    -H 'content-type: application/json' -d '{"status":"IN_PROGRESS"}' > /dev/null
  curl -sS -b "$jar" -X POST "$BASE/api/complaints/$cid/status" \
    -H 'content-type: application/json' -d "{\"status\":\"RESOLVED\",\"note\":\"$note\"}" > /dev/null
}

staff_for() {
  case "$1" in
    IT*) echo 'staff@campus.edu' ;;
    Maintenance*) echo 'staff.mnt@campus.edu' ;;
    Hostel*) echo '' ;;
    *) echo '' ;;
  esac
}

login 'student@campus.edu' "$WORK/student.jar"

echo '── complaint A: resolved, but the student says it is not fixed'
run_case 'The projector in the CSE seminar hall will not switch on.' "$WORK/student.jar" > "$WORK/a.json"
A=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["complaint"]["id"])' "$WORK/a.json")
A_DEPT=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["complaint"].get("department") or "")' "$WORK/a.json")
A_STAFF=$(staff_for "$A_DEPT")
[ -n "$A_STAFF" ] || { echo "   FAIL: routed to '$A_DEPT', which has no seeded staff login"; exit 1; }
login "$A_STAFF" "$WORK/staff.jar"
echo "   $A_DEPT · $A_STAFF"

# Nothing to confirm before there is a resolution, and nothing to rate either.
EARLY=$(code_of "$WORK/student.jar" "/api/complaints/$A/confirm" '{"confirmed":true}')
EARLY_RATE=$(code_of "$WORK/student.jar" "/api/complaints/$A/feedback" '{"rating":5}')
echo "   confirming before a resolution → $EARLY · rating before one → $EARLY_RATE"
[ "$EARLY" = '409' ] && [ "$EARLY_RATE" = '409' ] || { echo '   FAIL: expected 409 for both'; exit 1; }

resolve "$A" "$WORK/staff.jar" 'Lamp module replaced.'
view "$A" RESOLVED confirm

# §23 is the reporter's question. Staff answering it is the "it disappeared"
# this layer exists to prevent.
BY_STAFF=$(code_of "$WORK/staff.jar" "/api/complaints/$A/confirm" '{"confirmed":true}')
echo "   staff confirming on the student's behalf → $BY_STAFF"
[ "$BY_STAFF" = '403' ] || { echo "   FAIL: expected 403, got $BY_STAFF"; exit 1; }

SILENT=$(code_of "$WORK/student.jar" "/api/complaints/$A/confirm" '{"confirmed":false}')
echo "   \"still broken\" with no explanation → $SILENT"
[ "$SILENT" = '400' ] || { echo "   FAIL: expected 400, got $SILENT"; exit 1; }

curl -sS -b "$WORK/student.jar" -X POST "$BASE/api/complaints/$A/confirm" \
  -H 'content-type: application/json' \
  -d '{"confirmed":false,"reason":"It powered on once and died again the same afternoon."}' > /dev/null
view "$A" REOPENED nothing

python3 - "$WORK/view.json" <<'PY'
import json, sys
v = json.load(open(sys.argv[1]))
c = v["complaint"]
heads = [u["headline"] for u in v["updates"]]
for u in v["updates"][-3:]:
    print("   %s  %s%s" % (u["at"][11:16], u["headline"], " — " + u["detail"] if u["detail"] else ""))

fails = []
if c["reopenCount"] != 1:
    fails.append("reopenCount is %s, expected 1" % c["reopenCount"])
if "Resolution rejected" not in heads:
    fails.append("the feed does not record that the student rejected the resolution")
if not any("Reopened" in h for h in heads):
    fails.append("the feed does not record the reopen")
if c["resolvedAt"] is not None:
    fails.append("a reopened complaint still carries its old resolution time")
# §23 re-flags the department: a fresh promise, not the old broken one.
if c["sla"]["expectedResolutionBy"] is not None:
    fails.append("the reopened complaint kept the deadline of the attempt that failed")
for f in fails:
    print("   FAIL: %s" % f)
sys.exit(1 if fails else 0)
PY

echo
echo '── the department picks it up again, and this time the student agrees'
resolve "$A" "$WORK/staff.jar" 'Replaced the projector unit outright.'
view "$A" RESOLVED confirm
curl -sS -b "$WORK/student.jar" -X POST "$BASE/api/complaints/$A/confirm" \
  -H 'content-type: application/json' -d '{"confirmed":true}' > "$WORK/confirmed.json"
view "$A" CLOSED rate

curl -sS -b "$WORK/student.jar" -X POST "$BASE/api/complaints/$A/feedback" \
  -H 'content-type: application/json' \
  -d '{"rating":4,"comment":"Took two tries but the new unit works."}' > /dev/null
view "$A" CLOSED nothing

python3 - "$WORK/view.json" <<'PY'
import json, sys
v = json.load(open(sys.argv[1]))
c = v["complaint"]
heads = [u["headline"] for u in v["updates"]]
fails = []
if not c["feedback"] or c["feedback"]["rating"] != 4:
    fails.append("the rating was not stored")
elif not c["feedback"]["resolutionConfirmed"]:
    fails.append("a rating given after the student confirmed the fix is not marked as confirmed")
if "Resolution confirmed" not in heads:
    fails.append("the feed does not record the student's confirmation")
if not any(h.startswith("Feedback submitted") and "4/5" in h for h in heads):
    fails.append("the feed does not show the rating (§20 reads words and numbers, not enums)")
for f in fails:
    print("   FAIL: %s" % f)
print("   feed tail: %s" % " · ".join(heads[-4:]))
sys.exit(1 if fails else 0)
PY

RETRY=$(code_of "$WORK/student.jar" "/api/complaints/$A/feedback" '{"rating":1}')
echo "   rating the same complaint twice → $RETRY"
[ "$RETRY" = '409' ] || { echo "   FAIL: expected 409, got $RETRY"; exit 1; }

echo
echo '── complaint B: confirmed first time'
run_case 'The tube light in CSE 101 keeps flickering.' "$WORK/student.jar" > "$WORK/b.json"
B=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["complaint"]["id"])' "$WORK/b.json")
B_DEPT=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["complaint"].get("department") or "")' "$WORK/b.json")
B_STAFF=$(staff_for "$B_DEPT")
[ -n "$B_STAFF" ] || { echo "   FAIL: routed to '$B_DEPT', which has no seeded staff login"; exit 1; }
login "$B_STAFF" "$WORK/staffb.jar"
resolve "$B" "$WORK/staffb.jar" 'Choke replaced.'
curl -sS -b "$WORK/student.jar" -X POST "$BASE/api/complaints/$B/confirm" \
  -H 'content-type: application/json' -d '{"confirmed":true}' > /dev/null
curl -sS -b "$WORK/student.jar" -X POST "$BASE/api/complaints/$B/feedback" \
  -H 'content-type: application/json' -d '{"rating":5,"comment":"Same day. Thank you."}' > /dev/null
view "$B" CLOSED nothing

echo
echo "── another student cannot answer for this one"
login 'student2@campus.edu' "$WORK/other.jar"
STRANGER=$(code_of "$WORK/other.jar" "/api/complaints/$B/feedback" '{"rating":1}')
echo "   a stranger rating it → $STRANGER"
[ "$STRANGER" = '404' ] || { echo "   FAIL: expected 404 (they should not learn it exists), got $STRANGER"; exit 1; }

echo
echo 'gate: a resolution is not an ending until the student says so — declining reopens with a reason and a fresh promise, confirming closes and is rated once, and neither question can be answered by anyone else'
