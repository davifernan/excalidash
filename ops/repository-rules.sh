#!/usr/bin/env bash
# Applies the delivery rules that GitHub can enforce on this repository.
#
#   ops/repository-rules.sh apply    # write the configuration
#   ops/repository-rules.sh show     # print the current state
#
# Requires an authenticated `gh` with admin rights on the repository.
#
# What this sets, and why it is exactly this much:
#
#   allow_squash_merge=false  A squash merge through the GitHub UI attributes the
#                             resulting commit to the merging account, which destroys
#                             the Nilo authorship AGENTS.md requires. Does not affect
#                             the local merge path.
#   non_fast_forward          No force-pushes to main. A rewritten main would strand
#                             every worktree and every open PR base.
#   deletion                  main cannot be deleted.
#
# What this deliberately does NOT set:
#
#   pull_request              "Require a pull request before merging" blocks the local
#                             Nilo merge-and-push, which is the delivery model. PRs and
#                             Hans reviews remain convention, not enforcement.
#   required_status_checks    Measured on 2026-08-23 against a throwaway branch: a
#                             ruleset with required_status_checks rejects a direct push
#                             with "GH013 ... Required status check is expected", because
#                             a freshly pushed commit carries no check runs yet. The
#                             merge commit the local path pushes is always a new SHA, so
#                             this rule would reject every delivery. Removing the rule
#                             let the identical push through. See
#                             docs/architecture/UPSTREAM_MAINTENANCE.md.
#
# Note on check names: required_status_checks match job names ("Backend Tests",
# "Dead Code", ...), not workflow names. There is no check called "Tests", and a
# required check no workflow produces blocks every push permanently -- which is
# also why the retired "PR Overseer Events" must never appear in such a list.

set -euo pipefail

REPO="${REPO:-davifernan/excalidash}"
BRANCH="${BRANCH:-main}"
RULESET_NAME="delivery-guardrails"

ruleset_payload() {
  cat <<JSON
{
  "name": "${RULESET_NAME}",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/${BRANCH}"], "exclude": [] } },
  "rules": [ { "type": "non_fast_forward" }, { "type": "deletion" } ]
}
JSON
}

ruleset_id() {
  gh api "repos/${REPO}/rulesets" --jq ".[] | select(.name == \"${RULESET_NAME}\") | .id" 2>/dev/null | head -1
}

case "${1:-show}" in
  apply)
    echo "Disabling squash merge on ${REPO}..."
    gh api -X PATCH "repos/${REPO}" -F allow_squash_merge=false >/dev/null

    existing="$(ruleset_id)"
    if [ -n "${existing}" ]; then
      echo "Updating ruleset ${RULESET_NAME} (${existing})..."
      ruleset_payload | gh api -X PUT "repos/${REPO}/rulesets/${existing}" --input - >/dev/null
    else
      echo "Creating ruleset ${RULESET_NAME}..."
      ruleset_payload | gh api -X POST "repos/${REPO}/rulesets" --input - >/dev/null
    fi
    echo "Done."
    "$0" show
    ;;

  show)
    echo "== merge settings =="
    gh api "repos/${REPO}" --jq '{allow_squash_merge,allow_merge_commit,allow_rebase_merge}'
    echo "== rulesets =="
    gh api "repos/${REPO}/rulesets" --jq '.[] | {id, name, enforcement}'
    echo "== rules active on ${BRANCH} =="
    gh api "repos/${REPO}/rules/branches/${BRANCH}" --jq '.[].type'
    ;;

  revert)
    # Emergency undo: removes the ruleset and re-enables squash merge.
    existing="$(ruleset_id)"
    [ -n "${existing}" ] && gh api -X DELETE "repos/${REPO}/rulesets/${existing}" && echo "Ruleset removed."
    gh api -X PATCH "repos/${REPO}" -F allow_squash_merge=true >/dev/null
    echo "Squash merge re-enabled."
    ;;

  *)
    echo "Usage: $0 apply|show|revert" >&2
    exit 1
    ;;
esac
