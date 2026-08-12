#!/usr/bin/env bash
# Layer 3 gate, both halves. Needs `npm run dev` on :3000 and a seeded DB.
#
#   scripts/layer3-gate.sh
#
# Prints the extractor that read the message, what it pre-filled, how many
# questions the engine then asked, and the resulting complaint. Run it once with
# GROQ_API_KEY set and once with it blank: the LLM run should pre-fill the safety
# and problem slots and ask at least 3 fewer questions, and *both* runs must
# reach a submitted complaint.
set -euo pipefail

BASE=${BASE:-http://localhost:3000}
TEXT=${TEXT:-'There is exposed electrical wiring near the hostel entrance in Boys Hostel A'}
JAR=$(mktemp)
trap 'rm -f "$JAR"' EXIT

curl -sS -c "$JAR" -X POST "$BASE/api/auth/login" \
  -H 'content-type: application/json' \
  -d '{"email":"student@campus.edu","password":"password123"}' > /dev/null

START=$(TEXT="$TEXT" python3 -c 'import json,os;print(json.dumps({"rawText":os.environ["TEXT"]}))')
DRAFT=$(curl -sS -b "$JAR" -X POST "$BASE/api/drafts" -H 'content-type: application/json' -d "$START")

python3 - "$DRAFT" <<'PY'
import json, sys
d = json.loads(sys.argv[1])["draft"]
print(f'extractor      : {d["extractionSource"]}')
print(f'category       : {d["categoryKey"]}')
print(f'pre-filled     : {[(s["slotKey"], s["display"]) for s in d["summary"]]}')
print(f'next step      : {d["step"]["kind"]} {d["step"].get("slotKey", "")}')
PY

ID=$(python3 -c 'import json,sys;print(json.loads(sys.argv[1])["draft"]["id"])' "$DRAFT")

# Answer each remaining question with a benign option, so the safety
# short-circuit does not cut the comparison short.
ASKED=0
for _ in $(seq 1 12); do
  VIEW=$(curl -sS -b "$JAR" "$BASE/api/drafts/$ID")
  BODY=$(python3 - "$VIEW" <<'PY'
import json, sys
step = json.loads(sys.argv[1])["draft"]["step"]
if step["kind"] != "QUESTION":
    sys.exit(1)
opts = [o["value"] for o in step["options"]]
key = step["slotKey"]
if step["type"] == "location":
    body = {"action": "answer", "slotKey": key, "kind": "UNSURE"}
elif step["type"] == "boolean":
    body = {"action": "answer", "slotKey": key, "kind": "VALUE", "value": False}
elif step["type"] == "multi":
    body = {"action": "answer", "slotKey": key, "kind": "VALUE",
            "value": ["NONE" if "NONE" in opts else opts[0]]}
elif opts:
    body = {"action": "answer", "slotKey": key, "kind": "VALUE", "value": opts[0]}
else:
    body = {"action": "answer", "slotKey": key, "kind": "VALUE", "value": "no further detail"}
print(json.dumps(body))
print(f'  asked        : {key}', file=sys.stderr)
PY
) || break
  curl -sS -b "$JAR" -X POST "$BASE/api/drafts/$ID" -H 'content-type: application/json' -d "$BODY" > /dev/null
  ASKED=$((ASKED + 1))
done
echo "questions asked: $ASKED"

curl -sS -b "$JAR" -X POST "$BASE/api/drafts/$ID/submit" | python3 -c '
import json, sys
d = json.load(sys.stdin)
c = d["complaint"]
print("submitted      : %s — \"%s\" -> %s (triage=%s)" % (c["code"], c["title"], c["department"], c["needsTriage"]))
print("short-circuit  : %s" % d["safetyShortCircuit"])
'
