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

# The target must be a commit whose check-runs are FINISHED, not main's tip.
# Measured 25.08.2026: against the tip, ground truth read 41 and the paginated
# walk read 42 moments later -- a check-run had appeared between the two calls.
# Every assertion below compares numbers from separate live reads, so a target
# that is still accumulating check-runs makes all of them flaky at once. That
# produced three separate false failures in one afternoon.
#
# The newest release tag is the honest choice: it is real, already merged, has
# far more check-runs than per_page=2 (so genuine pagination still happens),
# and -- unlike the tip -- nothing new lands on it. It also moves forward on
# its own with each release instead of ageing into a pinned SHA.
echo "Resolving a real, already-merged commit with completed check-runs..."
if [ -n "${RELEASE_CHECK_RUNS_TEST_SHA:-}" ]; then
  TARGET_SHA="$RELEASE_CHECK_RUNS_TEST_SHA"
  echo "Target: $TARGET_SHA (explicit override)"
else
  NEWEST_TAG="$(gh api "repos/${REPO}/tags?per_page=100" --jq '[.[] | select(.name | test("^v[0-9]+\\.[0-9]+\\.[0-9]+$"))] | first | .commit.sha // empty')"
  if [ -n "$NEWEST_TAG" ]; then
    TARGET_SHA="$NEWEST_TAG"
    echo "Target: $TARGET_SHA (newest release tag -- check-runs are settled)"
  else
    TARGET_SHA="$(gh api "repos/${REPO}/commits/main" --jq '.sha')"
    echo "Target: $TARGET_SHA (no release tag found; falling back to main's tip)"
  fi
fi

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
# Two bounds instead of equality, for the same reason the unrelated-id check
# below uses `-lt`: both numbers come from separate live API reads on an active
# repo, so a check-run can appear between them and push the second read *up*.
# Measured 25.08.2026 on PR #150 -- got 21 where 40 - 20 = 20 was expected, and
# the one extra had nothing to do with filtering.
#
# The property under test is "excluding a run removes exactly its check-runs":
#   - it must remove something          -> EXCLUDED_TOTAL < BASELINE_TOTAL
#   - it must not remove more than its own -> EXCLUDED_TOTAL >= EXPECTED_TOTAL
# Drift between the reads can only add, so it lives inside the upper bound and
# cannot mask over-removal, which is the failure this guards against.
if [ "$EXCLUDED_TOTAL" -ge "$BASELINE_TOTAL" ]; then
  echo "FAIL: excluding run $SAMPLE_RUN_ID removed nothing ($BASELINE_TOTAL -> $EXCLUDED_TOTAL)."
  exit 1
fi
if [ "$EXCLUDED_TOTAL" -lt "$EXPECTED_TOTAL" ]; then
  echo "FAIL: excluding run $SAMPLE_RUN_ID removed MORE than its own $SAMPLE_COUNT check-run(s) -- total $EXCLUDED_TOTAL, floor $EXPECTED_TOTAL ($BASELINE_TOTAL - $SAMPLE_COUNT)."
  exit 1
fi
echo "PASS: excluding a real run removed its $SAMPLE_COUNT check-run(s) and no more."

# The other direction: an id that produced nothing here must change nothing.
# 1 is a real GitHub run id somewhere, but not on this commit.
UNRELATED_TOTAL="$(EXCLUDE_RUN_IDS="1" "$ROOT/scripts/release-check-runs.sh" "$REPO" "$TARGET_SHA" 2 | jq '.total')"
# Compared with `-lt`, not `!=`, on purpose. Both numbers come from separate
# live API reads, and this repo is active: a check-run can appear between the
# two, which pushes the second read *up*. That happened for real -- 44 then 45
# -- and failed this test for a reason that had nothing to do with filtering.
#
# The property under test is "excluding an id that is not here removes
# nothing". Growth does not violate it; shrinkage does. Asserting equality
# tested the repo's quietness, not the filter.
if [ "$UNRELATED_TOTAL" -lt "$BASELINE_TOTAL" ]; then
  echo "FAIL: excluding an unrelated run id REMOVED check-runs ($BASELINE_TOTAL -> $UNRELATED_TOTAL) -- the filter is matching more than the run it was given."
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
