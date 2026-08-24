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

gh api "$URL" --paginate --slurp | jq '
  ([.[].check_runs[]]) as $runs
  | {
      total: ($runs | length),
      incomplete: ([$runs[] | select(.status != "completed")] | length),
      failed: ([$runs[] | select(.status == "completed" and (.conclusion != "success" and .conclusion != "skipped" and .conclusion != "neutral"))] | length),
      failed_names: [$runs[] | select(.status == "completed" and (.conclusion != "success" and .conclusion != "skipped" and .conclusion != "neutral")) | .name]
    }
'
