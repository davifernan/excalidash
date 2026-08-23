# Delivery v2 control plane

Status: binding execution, PR, evidence, and Release-QA contract

Delivery v2 has one execution unit: the Ownership Package. Acceptance Slices describe what a
package must prove, but do not own agents, sessions, worktrees, branches, or runs. The pure
contract in `scripts/delivery-v2.cjs` is the machine-readable counterpart to `AGENTS.md`.

## Issue model

An Ownership Package has:

```json
{
  "pipeline_schema_version": "2",
  "delivery_model": "ownership_package",
  "execution_unit": true,
  "package_status": "unclaimed",
  "package_owner_agent_id": null,
  "package_owner_session_id": null,
  "package_worktree": null,
  "current_slice": null
}
```

An Acceptance Slice has:

```json
{
  "pipeline_schema_version": "2",
  "delivery_model": "acceptance_slice",
  "execution_unit": false,
  "parent_package": "NIL-NNN"
}
```

Only the first shape is dispatchable. Missing, false, or contradictory metadata fails closed.

## Dispatch and canonical ownership

Every controller calls the routing command before assignment or run creation:

```text
node scripts/delivery-v2.cjs route
```

Input is one issue snapshot and one stable trigger:

```json
{
  "issue": { "identifier": "NIL-404", "metadata": {} },
  "trigger": { "kind": "package_dispatch", "event_id": "stable-source-event-id" }
}
```

Supported triggers are:

- `package_dispatch`: only an unclaimed Ownership Package; creates the one owner claim.
- `owner_resume`: route the next serial PR to the recorded owner session.
- `finding_fix`: route PR findings back to that same owner session.
- `qa_followup`: route package-QA work back to that same owner session.
- `ordinary_comment`: explicitly non-routing. It never starts an implementer.

An accepted result contains `dispatch:true`, the canonical owner when one exists, a stable
idempotency key, and `maxActiveSessions:12`. Dispatch infrastructure must persist/use that key
when it creates the run. A rejected result exits non-zero and contains a reason suitable for
the controller log. No controller may reinterpret a rejection as permission.

Claim planning uses the same admission path:

```text
node scripts/delivery-v2.cjs claim
```

It returns the complete owner metadata write. Store those keys together before product-file
work. A second `package_dispatch` is rejected once the owner record exists. Later PRs keep the
owner, session, and package worktree; only `current_slice`, package status, and PR branch move.

## PR contract

Every PR body has exactly one primary package:

```text
Multica-Package: NIL-404
Delivery-Slices: NIL-410, NIL-411
Package-Session: 01a02bc5-fe01-7ce3-b520-387137968d9a
Impact-Manifest: generated from git diff
Visual-Evidence: provided
```

Use `Delivery-Slices: none` for package-only control-plane work. A slice cannot equal the
primary package, and duplicate slices are invalid. The Package Session is the canonical owner
session recorded on the package.

The admission gate requires these exact labels at the start of checked lines:

```text
- [x] Multica HANDOFF posted
- [x] Local verification complete
- [x] Ready for Hans-Friedrich
```

An uppercase checkbox marker (`[X]`), trailing horizontal whitespace, and explanatory text
after whitespace following the complete label are accepted. The label itself is case-sensitive
and cannot be rewritten or replaced by a semantic alias. The Hans workflow checks the merge
candidate with `scripts/delivery-v2.cjs admission` before requesting the one full review.

PR and review wake events transport the same contract without turning event normalization
into an admission gate. A missing or still-unfilled template produces `primary_package:null`
and `delivery_contract_error:null`. A malformed filled contract produces
`primary_package:null` plus the parser message in `delivery_contract_error`, so consumers can
distinguish broken input while the PR Overseer wake path remains available. Admission is the
enforcement boundary and still rejects placeholders or malformed contracts.

## Diff-derived impact manifest

Generate the manifest from the base/head range used by the PR:

```text
PR_BASE_SHA=<40-char-sha> \
PR_HEAD_SHA=<40-char-sha> \
PR_LABELS_JSON='[{"name":"frontend"}]' \
node scripts/delivery-v2.cjs impact
```

The command executes `git diff --name-only base...head`. Labels remain visible in the result,
but file buckets determine effective impact. Therefore a missing frontend label cannot hide a
frontend product change, and a stale frontend label cannot force a browser matrix on a
backend-only diff.

The manifest distinguishes:

- visible frontend product files;
- frontend tests/E2E only;
- non-visible frontend infrastructure;
- backend, operations, documentation, and other files.

Visible frontend product files require `Visual-Evidence: provided` plus final-head Multica
attachments that name scenario, viewport, and expected result. Test-only frontend changes use
`Visual-Evidence: skipped: test-only frontend delta`. Every other non-visible change uses
`Visual-Evidence: skipped: no visible frontend product delta`.

Backend/operations work receives relevant negative, API, security, data, limit, retry,
reconnect, or deployment tests. It does not inherit a full browser/mobile/screenshot matrix.
A UI-consumed backend contract may receive a narrow smoke test by explicit risk judgment.

## Review state

Admission runs on `opened`, `ready_for_review`, `synchronize`, `edited`, and `reopened`, so a
corrected PR can prove its delivery contract without a draft-toggle workaround. The expensive
Hans-Friedrich request in that workflow runs only on `opened` or `ready_for_review`. If initial
admission failed, the pipeline sentinel requests the first review after the corrected head is
stable; once any valid Hans review exists, it never requests a second full review automatically.
The ready head is frozen while the general review runs. If a finding fix changes the head, the
old review remains the single full review and `hans_sha..fix_sha` receives a machine-readable
fix-verification record. A new or unrelated push cannot inherit that evidence and requires
explicit re-admission rather than an automatic second full review.

## Release QA anchor

Release QA is planned with:

```text
node scripts/delivery-v2.cjs release-qa
```

The input includes `lastQaSha`, `currentMainSha`, `integrationsSinceQa`, package/high-risk/tag
booleans, and the integration impact manifests. The output always identifies the exact
`last_qa_sha..current_main_sha` range. QA is required when any condition is true:

- the package is complete;
- three PRs have integrated since the anchor;
- a High Risk PR integrated;
- a release or deployment tag is about to be made.

The range impact decides the QA surface. Visible frontend product impact requires browser
evidence; other ranges keep their narrower risk-based verification.

The QA agent posts one package comment:

```text
RELEASE QA
Package:
Range: <last_qa_sha>..<current_main_sha>
Trigger:
Impact manifest:
Verification:
Visual evidence: <attachments or exact skip>
Result:
Remaining risks:
```

On a completed QA run, update `last_qa_sha`, `last_qa_result`, and `last_qa_frontend` on the
package. Findings remain review/package findings unless they are genuinely independent
roadmap work. Release QA does not create a ticket swarm.

## Replacement boundary

This contract replaces issue-per-microtask and child-dispatch control. There is no feature
flag, compatibility route, line-count gate, PR-count gate, or transitional dual path.
Coherent product contracts determine PR boundaries.
