#!/bin/bash
set -euo pipefail

# Counterprobe for scripts/release-check-runs.sh (NIL-507, following up on
# Hans-Friedrich's finding on PR #79).
#
# Runs against the REAL GitHub API and a REAL, already-merged commit --
# never a mock -- per Davi's explicit instruction: "indem du per_page klein
# setzt, sodass die echten [...] Runs auf mehrere Seiten fallen [...] ist
# ehrlicher, weil es die echte API benutzt." A test that only exercises the
# single-page case proves nothing (the bug this guards against only appears
# once a commit's check-runs genuinely span more than one page), so this
# test forces a small `per_page` against a commit that has more check-runs
# than that, so real pagination happens, not a simulation of it.
#
# GREEN: scripts/release-check-runs.sh, forced to real multi-page (per_page
# small), must total to the same number the API's own `total_count` field
# reports (that field is correct regardless of page size, so it is a cheap,
# trustworthy ground truth -- no separate "fetch everything" call needed).
#
# RED: the historical buggy pattern (`gh api --paginate --jq '.check_runs'`,
# the exact line Hans-Friedrich found on release.yml@950e9cb before the fix)
# run against the SAME real multi-page data must NOT match that ground
# truth -- proving this counterprobe can tell broken from fixed using real
# API responses, not just its own fixture's shape.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="${RELEASE_CHECK_RUNS_TEST_REPO:-davifernan/excalidash}"

echo "Resolving a real, already-merged commit with completed check-runs..."
TARGET_SHA="${RELEASE_CHECK_RUNS_TEST_SHA:-$(gh api "repos/${REPO}/commits/main" --jq '.sha')}"
echo "Target: $TARGET_SHA"

GROUND_TRUTH="$(gh api "repos/${REPO}/commits/${TARGET_SHA}/check-runs?per_page=1" --jq '.total_count')"
echo "Ground truth total_count (one real API response, correct regardless of page size): $GROUND_TRUTH"

if [ "$GROUND_TRUTH" -le 2 ]; then
  echo "SKIP: $TARGET_SHA only has $GROUND_TRUTH check-run(s) -- cannot force a genuine multi-page split at per_page=2."
  echo "Re-run once main's tip has more check-runs, or set RELEASE_CHECK_RUNS_TEST_SHA to a commit that does."
  exit 0
fi

echo
echo "=== GREEN: scripts/release-check-runs.sh, forced to real multi-page (per_page=2) ==="
FIXED_RESULT="$("$ROOT/scripts/release-check-runs.sh" "$REPO" "$TARGET_SHA" 2)"
FIXED_TOTAL="$(echo "$FIXED_RESULT" | jq '.total')"
echo "Fixed script's total: $FIXED_TOTAL"
if [ "$FIXED_TOTAL" != "$GROUND_TRUTH" ]; then
  echo "FAIL: fixed script's total ($FIXED_TOTAL) does not match ground truth ($GROUND_TRUTH)"
  exit 1
fi
echo "PASS: fixed script correctly merges real multi-page check-runs."

echo
echo "=== RED: the historical buggy pattern against the SAME real multi-page data ==="
BUGGY_RAW="$(gh api "repos/${REPO}/commits/${TARGET_SHA}/check-runs?per_page=2" --paginate --jq '.check_runs')"
BUGGY_JQ_LENGTH="$(echo "$BUGGY_RAW" | jq 'length')"
if [ "$BUGGY_JQ_LENGTH" = "$GROUND_TRUTH" ]; then
  echo "FAIL: the historical buggy pattern happened to produce the ground-truth total for this input -- rerun against a commit whose check-run count does not collapse to a single line by coincidence."
  exit 1
fi
echo "CONFIRMED RED: the historical buggy pattern's \`jq 'length'\` on this real multi-page data is:"
printf '%s\n' "$BUGGY_JQ_LENGTH" | sed 's/^/    /'
echo "...not the single number $GROUND_TRUTH -- exactly the per-page-not-merged fault Hans-Friedrich found, reproduced against live data."

echo
echo "release-check-runs.test.sh: PASS (green fix verified, red bug reproduced, both against the real API)"
