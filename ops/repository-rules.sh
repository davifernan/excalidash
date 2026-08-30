#!/usr/bin/env bash
# Applies the delivery rules that GitHub can enforce on this repository.
#
#   ops/repository-rules.sh apply    # write the configuration
#   ops/repository-rules.sh show     # print the current state
#   ops/repository-rules.sh verify   # fail if the live state has drifted from this file
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
#   required_status_checks    Every Tests job must be green. This DOES coexist with the
#                             local merge path -- see the note below; an earlier version
#                             of this file claimed the opposite.
#
# What this deliberately does NOT set:
#
#   pull_request              "Require a pull request before merging" blocks the local
#                             Nilo merge-and-push, which is the delivery model. That a
#                             PR is opened and reviewed stays convention.
#
# Why required_status_checks works here, since it is not obvious:
#
#   A push of a brand-new commit with no check runs IS rejected -- measured on a
#   throwaway branch: "GH013 ... Required status check \"Backend Tests\" is expected".
#   But the merge commit of an open pull request whose required checks are green is
#   ACCEPTED, even though that merge commit itself has no check runs. Measured on
#   2026-08-23 pushing 85c3919 (the merge of PR #46) to main with this rule active:
#   the rule suite records required_status_checks as evaluated with result "pass",
#   not bypassed. Both halves matter: the rule bites, and it does not block delivery.
#
# Note on check names: required_status_checks match job names ("Backend Tests",
# "Dead Code", ...), not workflow names. There is no check called "Tests", and a
# required check no workflow produces blocks every push permanently -- which is
# also why the retired "PR Overseer Events" must never appear in the list below.
#
# "Build and push" is deliberately absent: it runs on workflow_run after Tests
# completes on main, so requiring it would deadlock every push.
#
# "Authz Boundary" (NIL-487) is required for the same reason the adapter check is
# enforced: a boundary nobody has to pass is a suggestion. Note the ordering
# constraint that comes with it -- apply this rule only once the job exists on
# main. A required check that no workflow produces blocks every push, and an
# open PR branched before the job was added does not report it until its checks
# are re-run against the updated merge ref.

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
  "rules": [
    { "type": "non_fast_forward" },
    { "type": "deletion" },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [
          { "context": "Authz Boundary" },
          { "context": "Backend Tests" },
          { "context": "Dead Code" },
          { "context": "Delivery Contract Tests" },
          { "context": "E2E Browser Tests" },
          { "context": "E2E Built Image Smoke (NIL-649)" },
          { "context": "E2E Typecheck" },
          { "context": "Frontend Format" },
          { "context": "Frontend Typecheck" },
          { "context": "Frontend Unit Tests" },
          { "context": "Security Sanitization Tests" }
        ]
      }
    }
  ]
}
JSON
}

# Both expectations are derived from ruleset_payload() rather than restated, so
# there is one source of truth. A second hand-maintained list would be the very
# drift this script exists to catch.
expected_rule_types() {
  ruleset_payload | jq -r '.rules[].type' | sort -u
}

expected_contexts() {
  ruleset_payload |
    jq -r '.rules[] | select(.type == "required_status_checks")
           | .parameters.required_status_checks[].context' | sort
}

actual_contexts() {
  gh api "repos/${REPO}/rules/branches/${BRANCH}" \
    --jq '.[] | select(.type == "required_status_checks")
          | .parameters.required_status_checks[].context' | sort
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

  verify)
    # Guards the drift that produced this correction: the script silently stopped
    # matching the live configuration, so `apply` would have removed a rule that
    # was protecting main. Exits non-zero on any difference.
    actual="$(gh api "repos/${REPO}/rules/branches/${BRANCH}" --jq '.[].type' | sort -u)"
    expected="$(expected_rule_types)"
    squash="$(gh api "repos/${REPO}" --jq '.allow_squash_merge')"
    status=0
    if [ "${actual}" != "${expected}" ]; then
      echo "Rule drift on ${BRANCH}:" >&2
      diff <(echo "${expected}") <(echo "${actual}") | sed 's/^/  /' >&2
      status=1
    fi
    # Which checks are required is half the configuration. Comparing only rule
    # types reports green while a job has been quietly dropped from the list.
    actual_checks="$(actual_contexts)"
    expected_checks="$(expected_contexts)"
    if [ "${actual_checks}" != "${expected_checks}" ]; then
      echo "Required-check drift on ${BRANCH}:" >&2
      diff <(echo "${expected_checks}") <(echo "${actual_checks}") | sed 's/^/  /' >&2
      status=1
    fi
    if [ "${squash}" != "false" ]; then
      echo "allow_squash_merge is ${squash}, expected false" >&2
      status=1
    fi
    [ "${status}" -eq 0 ] && echo "Repository rules match this script."
    exit "${status}"
    ;;

  revert)
    # Emergency undo: removes the ruleset and re-enables squash merge.
    existing="$(ruleset_id)"
    [ -n "${existing}" ] && gh api -X DELETE "repos/${REPO}/rulesets/${existing}" && echo "Ruleset removed."
    gh api -X PATCH "repos/${REPO}" -F allow_squash_merge=true >/dev/null
    echo "Squash merge re-enabled."
    ;;

  *)
    echo "Usage: $0 apply|show|verify|revert" >&2
    exit 1
    ;;
esac
