#!/usr/bin/env bash
# Layer 10 gate: the dashboards, over the API and the rendered page.
# Needs `npm run dev` on :3000 and a seeded DB.
#
#   scripts/layer10-gate.sh
#
# `scripts/layer10-nokey.ts` proves the figures are *right* — it recounts every
# aggregate against the row-level modules. This script proves they are the *same
# figures everybody sees*, and that scope is decided by role rather than by URL:
#
#   · an administrator gets the campus (§31) — totals, distribution, department
#     comparison, heatmap (§28), health (§34);
#   · the numbers on the rendered page are the numbers the API returned;
#   · a staff member gets their own department (§32) and nothing else — no
#     campus-wide table, no other department's satisfaction;
#   · a student gets neither: 403 from the API, redirected away from the page;
#   · §30's scan is an administrator's action, and running it twice does not
#     duplicate what it recorded.
set -euo pipefail

BASE=${BASE:-http://localhost:3000}
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

login() {
  curl -sS -c "$2" -X POST "$BASE/api/auth/login" \
    -H 'content-type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"password123\"}" > /dev/null
}

status_of() {
  curl -sS -o /dev/null -w '%{http_code}' -b "$1" "$BASE$2"
}

post_status_of() {
  curl -sS -o "$WORK/last.json" -w '%{http_code}' -b "$1" -X POST "$BASE$2"
}

login 'admin@campus.edu' "$WORK/admin.jar"
login 'staff@campus.edu' "$WORK/staff.jar"
login 'student@campus.edu' "$WORK/student.jar"

echo '── §31: the campus overview an administrator gets'
curl -sS -b "$WORK/admin.jar" "$BASE/api/analytics/overview" > "$WORK/campus.json"
python3 - "$WORK/campus.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
t, h = d["totals"], d["health"]

print("   %d complaints · %d open (%d critical) · SLA %s · satisfaction %s · health %d/100 (%s)" % (
    t["total"], t["open"], t["openCritical"],
    "—" if t["slaCompliance"] is None else "%d%%" % round(t["slaCompliance"] * 100),
    "—" if d["satisfaction"]["average"] is None else "%.2f" % d["satisfaction"]["average"],
    h["score"], h["band"],
))
print("   top categories: %s" % ", ".join("%s %d%%" % (c["label"], round(c["share"] * 100)) for c in d["categories"][:4]))
print("   heatmap: %s" % ", ".join("%s %s(%d)" % (c["locationName"], c["level"], c["total"]) for c in d["heat"][:4]))

fails = []
if d["scope"] != "CAMPUS":
    fails.append("an administrator got scope %s" % d["scope"])
# The distribution has to account for every complaint, or a share means nothing.
counted = sum(c["count"] for c in d["categories"])
if counted != t["total"]:
    fails.append("category counts sum to %d, total is %d" % (counted, t["total"]))
shares = sum(c["share"] for c in d["categories"])
if t["total"] and abs(shares - 1) > 1e-9:
    fails.append("category shares sum to %s" % shares)
# §14's rule applied to §34: never a bare number.
if len(h["terms"]) != 5 or any(not term["detail"] for term in h["terms"]):
    fails.append("the health score is published without all five of its terms")
if not 0 <= h["score"] <= 100:
    fails.append("health score %s is outside 0..100" % h["score"])
# §31 compares departments; that means every seeded department is in the table.
if len(d["departments"]) < 6:
    fails.append("only %d departments in the comparison" % len(d["departments"]))
if d["heat"] and d["heat"][0]["total"] >= 3 and d["heat"][0]["level"] != "HIGH":
    fails.append("the busiest building is banded %s" % d["heat"][0]["level"])
for f in fails:
    print("   FAIL: %s" % f)
sys.exit(1 if fails else 0)
PY

echo
echo '── the rendered page shows the numbers the API returned'
curl -sS -b "$WORK/admin.jar" "$BASE/dashboard" > "$WORK/dashboard.html"
python3 - "$WORK/campus.json" "$WORK/dashboard.html" <<'PY'
import json, re, sys
api = json.load(open(sys.argv[1]))
html = open(sys.argv[2], encoding="utf-8").read()
# Next streams the page with escaped markup in the flight payload, so compare
# against a version with the HTML entities and tags removed.
text = re.sub(r"<[^>]+>", " ", html).replace("\\u003c", "<").replace("&#x27;", "'")

fails = []
checks = [
    ("total complaints", str(api["totals"]["total"])),
    ("health score", str(api["health"]["score"])),
]
if api["heat"]:
    checks.append(("busiest building", api["heat"][0]["locationName"]))
if api["categories"]:
    checks.append(("top category", api["categories"][0]["label"]))

for label, needle in checks:
    if needle not in text:
        fails.append("the page does not show the %s the API reports (%r)" % (label, needle))
    else:
        print("   %-18s %s ✓" % (label, needle))

for f in fails:
    print("   FAIL: %s" % f)
sys.exit(1 if fails else 0)
PY

echo
echo '── §32: a staff member gets their own department and nothing else'
curl -sS -b "$WORK/staff.jar" "$BASE/api/analytics/overview" > "$WORK/dept.json"
python3 - "$WORK/dept.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
t = d["totals"]
print("   %s · %d complaints · %d open · at risk %d (%d breached) · escalated %d · most common: %s" % (
    d["department"]["name"], t["total"], t["open"], d["atRisk"], d["breachedNow"], d["escalated"],
    d["commonIssue"]["label"] if d["commonIssue"] else "—",
))
print("   attention list: %s" % ", ".join("%s %s/%s" % (a["code"], a["priority"], a["risk"]) for a in d["attention"][:5]))

fails = []
if d["scope"] != "DEPARTMENT":
    fails.append("a staff member got scope %s" % d["scope"])
# §32 is a focused view. Campus-wide comparisons are not in it.
for leaked in ("departments", "heat", "categoryHealth"):
    if leaked in d:
        fails.append("the department payload carries campus-wide %s" % leaked)
if d["health"] and len(d["health"]["terms"]) != 5:
    fails.append("the department score is published without its terms")
# "SLA at risk" must be consistent with what it is counting.
if d["breachedNow"] > d["atRisk"]:
    fails.append("more breached (%d) than at risk (%d)" % (d["breachedNow"], d["atRisk"]))
if d["attention"] and any(a["priority"] == "LOW" for a in d["attention"][:1]) and d["openByPriority"]["CRITICAL"] > 0:
    fails.append("§21's order puts a LOW complaint above an open critical one")
for f in fails:
    print("   FAIL: %s" % f)
sys.exit(1 if fails else 0)
PY

echo
echo '── students see none of it'
API=$(status_of "$WORK/student.jar" '/api/analytics/overview')
PAGE=$(status_of "$WORK/student.jar" '/dashboard')
echo "   student → analytics API $API · dashboard page $PAGE"
[ "$API" = '403' ] || { echo "   FAIL: expected 403 from the API, got $API"; exit 1; }
# The page guard redirects a student to their own home rather than 403-ing a page.
case "$PAGE" in
  200) echo '   FAIL: a student rendered the dashboard'; exit 1 ;;
esac

echo
echo '── §30: recording the recurring signals is an administrator’s action'
STAFF_SCAN=$(post_status_of "$WORK/staff.jar" '/api/analytics/recurring/scan')
echo "   staff running the scan → $STAFF_SCAN"
[ "$STAFF_SCAN" = '403' ] || { echo "   FAIL: expected 403, got $STAFF_SCAN"; exit 1; }

curl -sS -b "$WORK/admin.jar" -X POST "$BASE/api/analytics/recurring/scan" > "$WORK/scan1.json"
curl -sS -b "$WORK/admin.jar" -X POST "$BASE/api/analytics/recurring/scan" > "$WORK/scan2.json"
python3 - "$WORK/scan1.json" "$WORK/scan2.json" <<'PY'
import json, sys
first, second = (json.load(open(p)) for p in sys.argv[1:3])
print("   first scan: %d detected, %d written, %d refreshed" % (first["detected"], first["written"], first["refreshed"]))
print("   second scan: %d detected, %d written, %d refreshed" % (second["detected"], second["written"], second["refreshed"]))

fails = []
if second["written"] != 0:
    fails.append("a rescan wrote %d duplicate signal row(s)" % second["written"])
if second["detected"] != first["detected"]:
    fails.append("two scans a second apart disagree about how many trends exist")
for signal in first["signals"]:
    if not signal["suggestion"]:
        fails.append("a recorded signal has no suggestion to act on (§30)")
if first["detected"] == 0:
    print("   note: no trend in the live database — every complaint in it was filed inside one month.")
    print("         §27's detector is gated over a real four-month trend by scripts/layer10-nokey.ts.")
for f in fails:
    print("   FAIL: %s" % f)
sys.exit(1 if fails else 0)
PY

echo
echo 'gate: the campus and department dashboards return role-scoped figures, the page shows the same numbers as the API, students are refused, and §30 records without duplicating'
