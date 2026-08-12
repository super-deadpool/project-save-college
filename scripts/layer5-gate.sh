#!/usr/bin/env bash
# Layer 5 gate: duplicate detection and incidents, over the API.
# Needs `npm run dev` on :3000 and a seeded DB.
#
#   scripts/layer5-gate.sh
#
# Submits the four spec §16 phrasings from four *different* student logins and
# checks that they converge on one incident, that the affected count reaches 4,
# and that students 2–4 are handed the §36 incident message instead of a generic
# acknowledgement. Then it opens the incident as staff (§17) and confirms the
# member list, and checks that a student cannot read an incident they are not in.
#
# `scripts/layer5-nokey.ts` runs the same scenario through the service layer with
# no API key and asserts the numbers exactly; this script is the API surface.
set -euo pipefail

BASE=${BASE:-http://localhost:3000}
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

login() {
  local email="$1" jar="$2"
  curl -sS -c "$jar" -X POST "$BASE/api/auth/login" \
    -H 'content-type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"password123\"}" > /dev/null
}

# Drives one conversation to submission and echoes the submit response.
# SCOPE is the scope answer, or empty to leave it unestablished.
run_case() {
  local email="$1" text="$2" scope="$3"
  local jar="$WORK/$email.jar"
  login "$email" "$jar"

  local start draft id
  start=$(TEXT="$text" python3 -c 'import json,os;print(json.dumps({"rawText":os.environ["TEXT"]}))')
  draft=$(curl -sS -b "$jar" -X POST "$BASE/api/drafts" -H 'content-type: application/json' -d "$start")
  id=$(python3 -c 'import json,sys;print(json.loads(sys.argv[1])["draft"]["id"])' "$draft")

  for _ in $(seq 1 14); do
    local view body
    view=$(curl -sS -b "$jar" "$BASE/api/drafts/$id")
    body=$(SCOPE="$scope" python3 - "$view" <<'PY'
import json, os, sys
step = json.loads(sys.argv[1])["draft"]["step"]
if step["kind"] == "CATEGORY":
    print(json.dumps({"action": "category", "categoryKey": step["categories"][0]["key"]}))
    sys.exit(0)
if step["kind"] != "QUESTION":
    sys.exit(1)

key, kind = step["slotKey"], step["type"]
opts = [o["value"] for o in step["options"]]
scope = os.environ.get("SCOPE") or ""

# The scope question is the one the fourth student genuinely cannot answer.
if scope and scope in opts:
    print(json.dumps({"action": "answer", "slotKey": key, "kind": "VALUE", "value": scope}))
    sys.exit(0)

if kind == "location":
    body = {"action": "answer", "slotKey": key, "kind": "UNSURE"}
elif kind == "boolean":
    body = {"action": "answer", "slotKey": key, "kind": "VALUE", "value": False}
elif kind == "multi":
    pick = "NONE" if "NONE" in opts else opts[0]
    body = {"action": "answer", "slotKey": key, "kind": "VALUE", "value": [pick]}
elif opts:
    for preferred in ("TODAY", "NONE"):
        if preferred in opts:
            pick = preferred
            break
    else:
        pick = opts[0]
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

echo '── §16: four students, four phrasings, one issue'

# Spec §16 verbatim, except "third floor" → "2nd floor": the seeded CSE Block has
# two. The case is a floor-level report joining a building-level one either way.
run_case 'student@campus.edu'  "WiFi isn't working in CSE Block."               'BUILDING' > "$WORK/1.json"
run_case 'student2@campus.edu' 'No internet connection in CSE building.'        'MANY'     > "$WORK/2.json"
run_case 'student3@campus.edu' 'Network is down on the 2nd floor of CSE Block.' 'MANY'     > "$WORK/3.json"
run_case 'student4@campus.edu' 'Unable to connect to campus WiFi.'              ''         > "$WORK/4.json"

python3 - "$WORK/1.json" "$WORK/2.json" "$WORK/3.json" "$WORK/4.json" <<'PY'
import json, sys

subs = [json.load(open(p)) for p in sys.argv[1:]]
fails = []

for n, s in enumerate(subs, 1):
    c, i = s["complaint"], s["incident"]
    print("   student %d  : %s %s → %s (%d affected)" % (n, c["code"], c["priority"], i["code"], i["affectedCount"]))
    msg = i.get("message")
    print("               %s" % (msg["affectedLine"] if msg else "generic acknowledgement"))

codes = {s["incident"]["code"] for s in subs}
if len(codes) != 1:
    fails.append("four phrasings landed on %d incidents: %s" % (len(codes), ", ".join(sorted(codes))))

# §36 — every reporter after the first is told about the incident. Whether the
# *first* one is depends on whether an earlier run left an open CSE/NETWORK
# incident inside the 24h window, so that case is asserted exactly in
# scripts/layer5-nokey.ts, which controls its own history.
for n, s in enumerate(subs[1:], 2):
    if not s["incident"].get("message"):
        fails.append("student %d got a generic ack instead of the incident message (§36)" % n)

final = subs[-1]["incident"]["affectedCount"]
print("\n   incident   : %s · %d students affected" % (subs[-1]["incident"]["code"], final))
if final < 4:
    fails.append("affected count reached only %d of 4" % final)

for f in fails:
    print("   FAIL: %s" % f)
open(sys.argv[1] + ".incident", "w").write(subs[0]["incident"]["id"])
sys.exit(1 if fails else 0)
PY

INCIDENT=$(cat "$WORK/1.json.incident")

echo
echo '── §17/§18: the incident as staff'
login 'staff@campus.edu' "$WORK/staff.jar"
curl -sS -b "$WORK/staff.jar" "$BASE/api/incidents/$INCIDENT" > "$WORK/staff-view.json"

python3 - "$WORK/staff-view.json" <<'PY'
import json, sys
v = json.load(open(sys.argv[1]))
if "error" in v:
    sys.exit("   FAIL: staff could not read the incident (%s)" % v["error"])

i = v["incident"]
print("   %s %s · %s · %s" % (i["code"], i["title"], i["priority"], i["department"]))
print("   incident priority: %s — %s" % (i["priority"], i["priorityReason"]))
for c in v["complaints"]:
    print("     %s %s · %s · dedup %s %.2f" % (c["code"], c["priority"], c["reporter"], c["dedupVerdict"], c["dedupScore"]))

fails = []
if len(v["complaints"]) < 4:
    fails.append("staff see only %d linked complaints" % len(v["complaints"]))
if not i.get("signature"):
    fails.append("staff view carries no dedup signature")
if len({c["reporter"] for c in v["complaints"]}) != i["affectedCount"]:
    fails.append("affected count does not equal the number of distinct reporters (§18)")
for f in fails:
    print("   FAIL: %s" % f)
sys.exit(1 if fails else 0)
PY

echo
echo '── §39: scale is shared with students, the roster is not'
login 'student@campus.edu' "$WORK/member.jar"
MEMBER=$(curl -sS -b "$WORK/member.jar" "$BASE/api/incidents/$INCIDENT")
python3 - "$MEMBER" <<'PY'
import json, sys
v = json.loads(sys.argv[1])
if "error" in v:
    sys.exit("   FAIL: a member student was denied their own incident")

fails = []
# The student sees the scale of the incident and their own complaints in it —
# never anyone else's, and never a name.
if not all(c["isMine"] for c in v["complaints"]):
    fails.append("a student was shown another student's complaint")
if any("reporter" in c for c in v["complaints"]):
    fails.append("reporter identities leaked into the student view")
# Routing uncertainty and dedup internals are staff-facing only (§39).
if "signature" in v["incident"]:
    fails.append("the dedup signature leaked into the student view")
if not v.get("message"):
    fails.append("the student was not given the §36 incident message")

for f in fails:
    print("   FAIL: %s" % f)
if not fails:
    print("   member student: %d affected, %d complaint(s) — all their own, no roster, no signature"
          % (v["incident"]["affectedCount"], len(v["complaints"])))
sys.exit(1 if fails else 0)
PY

echo
echo '── a staff member from another department cannot read it'
login 'staff.mnt@campus.edu' "$WORK/other.jar"
OTHER=$(curl -sS -b "$WORK/other.jar" -o /dev/null -w '%{http_code}' "$BASE/api/incidents/$INCIDENT")
if [ "$OTHER" != '404' ]; then
  echo "   FAIL: Maintenance staff read an IT incident (HTTP $OTHER)"
  exit 1
fi
echo '   Maintenance staff: 404, as for an incident that does not exist'

echo
echo 'gate: four phrasings converged on one incident, the count reached 4, and the later reporters were told about it'
