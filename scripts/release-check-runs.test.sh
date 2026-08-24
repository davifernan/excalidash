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
echo "=== EXCLUDE_RUN_IDS: removes exactly the named run, and nothing else ==="
# The defect this guards: the Release workflow registers its own check-run
# against the SHA it is asking about, so it counted itself -- `incomplete` on
# the first attempt, `failed` on every retry. The gate could never pass.
# Two directions have to hold, and a one-directional test would miss half:
# excluding a real run must actually drop its check-runs, and excluding an
# id that is not there must drop nothing at all.

BASELINE_TOTAL="$FIXED_TOTAL"

# Take a run id that genuinely produced check-runs on this commit.
SAMPLE_RUN_ID="$(gh api "repos/${REPO}/commits/${TARGET_SHA}/check-runs?per_page=100" --paginate --slurp \
  | jq -r '[.[].check_runs[]] | map(.details_url // "") | map(capture("/runs/(?<id>[0-9]+)/").id) | .[0] // ""')"
if [ -z "$SAMPLE_RUN_ID" ]; then
  echo "FAIL: could not read a run id out of any details_url -- the exclusion cannot be proven against this commit."
  exit 1
fi
SAMPLE_COUNT="$(gh api "repos/${REPO}/commits/${TARGET_SHA}/check-runs?per_page=100" --paginate --slurp \
  | jq --arg frag "/runs/${SAMPLE_RUN_ID}/" '[.[].check_runs[]] | map(select((.details_url // "") | contains($frag))) | length')"
echo "Sample run $SAMPLE_RUN_ID contributed $SAMPLE_COUNT check-run(s) of $BASELINE_TOTAL."

if [ "$SAMPLE_COUNT" -eq 0 ] || [ "$SAMPLE_COUNT" -ge "$BASELINE_TOTAL" ]; then
  echo "FAIL: the sample run contributes $SAMPLE_COUNT of $BASELINE_TOTAL check-runs -- that cannot tell a working exclusion from a broken one. Re-run against a commit whose check-runs come from more than one workflow run."
  exit 1
fi

EXCLUDED_TOTAL="$(EXCLUDE_RUN_IDS="$SAMPLE_RUN_ID" "$ROOT/scripts/release-check-runs.sh" "$REPO" "$TARGET_SHA" 2 | jq '.total')"
EXPECTED_TOTAL="$((BASELINE_TOTAL - SAMPLE_COUNT))"
if [ "$EXCLUDED_TOTAL" != "$EXPECTED_TOTAL" ]; then
  echo "FAIL: excluding run $SAMPLE_RUN_ID gave total $EXCLUDED_TOTAL, expected $EXPECTED_TOTAL ($BASELINE_TOTAL - $SAMPLE_COUNT)."
  exit 1
fi
echo "PASS: excluding a real run removed exactly its $SAMPLE_COUNT check-run(s)."

# The other direction: an id that produced nothing here must change nothing.
# 1 is a real GitHub run id somewhere, but not on this commit.
UNRELATED_TOTAL="$(EXCLUDE_RUN_IDS="1" "$ROOT/scripts/release-check-runs.sh" "$REPO" "$TARGET_SHA" 2 | jq '.total')"
if [ "$UNRELATED_TOTAL" != "$BASELINE_TOTAL" ]; then
  echo "FAIL: excluding an unrelated run id changed the total from $BASELINE_TOTAL to $UNRELATED_TOTAL -- the filter is matching more than the run it was given."
  exit 1
fi
echo "PASS: excluding an unrelated run id left all $BASELINE_TOTAL check-run(s) in place."

# And an empty exclusion must behave exactly like no exclusion at all -- the
# normal case for every other caller. An earlier draft of this change broke
# precisely here: `grep` exits 1 on no match, and under `set -e` the script
# produced no output at all.
EMPTY_TOTAL="$(EXCLUDE_RUN_IDS="" "$ROOT/scripts/release-check-runs.sh" "$REPO" "$TARGET_SHA" 2 | jq '.total')"
if [ "$EMPTY_TOTAL" != "$BASELINE_TOTAL" ]; then
  echo "FAIL: an empty EXCLUDE_RUN_IDS gave total '$EMPTY_TOTAL', expected $BASELINE_TOTAL."
  exit 1
fi
echo "PASS: an empty exclusion behaves exactly like no exclusion."

echo
echo "release-check-runs.test.sh: PASS (green fix verified, red bug reproduced, exclusion proven in both directions, all against the real API)"
