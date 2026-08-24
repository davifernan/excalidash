#!/bin/bash
set -euo pipefail

# scripts/release-check-runs.sh <repo> <sha> [per_page]
#
# Prints one JSON object counting ALL check-runs GitHub has recorded for
# <sha> in <repo>, correctly merged across however many pages the API
# actually returns:
#
#   {"total": N, "incomplete": N, "failed": N, "failed_names": [...]}
#
# Extracted out of .github/workflows/release.yml (NIL-507) so it is
# independently testable -- see release-check-runs.test.sh, which proves
# this against the real GitHub API with real pagination, not a fixture.
#
# EXCLUDE_RUN_IDS (env, newline-separated GitHub Actions run ids) drops the
# check-runs those runs produced. It exists for exactly one caller: the
# Release workflow asking "did this commit's CI pass". That workflow registers
# its OWN check-run against the very same SHA, so without this it counts
# itself: the first run sees itself as `incomplete` and refuses, and every
# retry additionally sees the previous attempt as `failed` and refuses again.
# The gate was unpassable by construction -- found on the first real release
# attempt (v0.7.0-nilo.1, 24.08.2026), which is also the first time the
# workflow from NIL-507 was ever exercised.
#
# This narrows WHO is counted, never WHAT counts as a pass: a run id has to be
# named explicitly, and everything else on the commit is still judged exactly
# as before. Excluding by run id rather than by job name survives a job being
# renamed, and cannot accidentally swallow an unrelated red check.
#
# `gh api --paginate --jq FILTER` runs FILTER once PER PAGE, not on the
# merged result (Hans-Friedrich, PR #79, live-verified against the real API:
# `gh api --paginate ".../commits?per_page=2" --jq 'length'` printed "2\n2"
# for two pages, not "4"). This endpoint also returns an object
# (`{check_runs: [...]}`), not a top-level array, so `--paginate` alone
# cannot concatenate pages either way -- `--slurp` is gh's own documented
# answer for that case: collect the raw pages into one array, then flatten
# `.check_runs` across all of them in a single downstream jq call, never
# per page.

REPO="${1:?usage: release-check-runs.sh <repo> <sha> [per_page]}"
SHA="${2:?usage: release-check-runs.sh <repo> <sha> [per_page]}"
PER_PAGE="${3:-}"

URL="repos/${REPO}/commits/${SHA}/check-runs"
if [ -n "$PER_PAGE" ]; then
  URL="${URL}?per_page=${PER_PAGE}"
fi

# Newline-separated run ids -> a jq array of the "/runs/<id>/" fragments that
# appear in a check-run's details_url.
# `grep` exits 1 on no match and `|| true` keeps that from killing the script
# under `set -e`: an empty EXCLUDE_RUN_IDS is the normal case, not an error.
EXCLUDE_JSON="$(printf '%s' "${EXCLUDE_RUN_IDS:-}" \
  | tr ' ' '\n' \
  | { grep -E '^[0-9]+$' || true; } \
  | jq -R '"/runs/" + . + "/"' \
  | jq -sc '.')"

gh api "$URL" --paginate --slurp | jq --argjson exclude "$EXCLUDE_JSON" '
  ([.[].check_runs[]] | map(select(
      (.details_url // "") as $u
      | ($exclude | map(. as $frag | $u | contains($frag)) | any) | not
   ))) as $runs
  | {
      total: ($runs | length),
      incomplete: ([$runs[] | select(.status != "completed")] | length),
      failed: ([$runs[] | select(.status == "completed" and (.conclusion != "success" and .conclusion != "skipped" and .conclusion != "neutral"))] | length),
      failed_names: [$runs[] | select(.status == "completed" and (.conclusion != "success" and .conclusion != "skipped" and .conclusion != "neutral")) | .name]
    }
'
