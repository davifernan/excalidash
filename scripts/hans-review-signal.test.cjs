"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  MEASUREMENT_MARKER,
  buildSignalComment,
  decideAdmissionEnforcement,
  decideReviewPreflight,
  hasSignalComment,
  signalMarker,
} = require("./hans-review-signal.cjs");

const HEAD_SHA = "a".repeat(40);
const REVIEW_CANDIDATE = {
  draft: false,
  authorType: "User",
  body: "ordinary body",
  repository: "davifernan/excalidash",
  headRepository: "davifernan/excalidash",
  author: "davifernan",
  association: "OWNER",
  extraTrusted: "",
};

test("drafts, forks, untrusted authors, bots, and marked measurements intentionally skip review", () => {
  assert.equal(decideReviewPreflight({ ...REVIEW_CANDIDATE, draft: true }).code, "draft");
  assert.equal(
    decideReviewPreflight({ ...REVIEW_CANDIDATE, authorType: "Bot" }).code,
    "bot-author",
  );
  assert.equal(
    decideReviewPreflight({ ...REVIEW_CANDIDATE, headRepository: "someone/excalidash" }).code,
    "fork",
  );
  assert.equal(
    decideReviewPreflight({ ...REVIEW_CANDIDATE, association: "CONTRIBUTOR" }).code,
    "untrusted-author",
  );
  assert.equal(
    decideReviewPreflight({ ...REVIEW_CANDIDATE, body: `Context\n${MEASUREMENT_MARKER}\n` }).code,
    "measurement-only",
  );
});

test("only the exact measurement marker skips a trusted ready PR", () => {
  assert.equal(decideReviewPreflight(REVIEW_CANDIDATE).action, "admit");
  assert.equal(
    decideReviewPreflight({ ...REVIEW_CANDIDATE, body: "Hans-Review: skipped" }).action,
    "admit",
  );
  assert.equal(
    decideReviewPreflight({ ...REVIEW_CANDIDATE, body: `${MEASUREMENT_MARKER} later` }).action,
    "admit",
  );
});

test("EXTRA_TRUSTED remains an explicit escape hatch for an otherwise untrusted author", () => {
  const decision = decideReviewPreflight({
    ...REVIEW_CANDIDATE,
    author: "trusted-contributor",
    association: "CONTRIBUTOR",
    extraTrusted: "another trusted-contributor",
  });
  assert.equal(decision.action, "admit");
});

test("intentional skip and delivery-contract comments explain different outcomes", () => {
  const skipDecision = decideReviewPreflight({ ...REVIEW_CANDIDATE, draft: true });
  const skipComment = buildSignalComment({ headSha: HEAD_SHA, decision: skipDecision });
  assert.match(skipComment, /bewusst nicht gestartet/);
  assert.match(skipComment, /bleibt rot/);
  assert.match(skipComment, /Wechsel auf ready/);
  assert.match(skipComment, new RegExp(signalMarker(HEAD_SHA, "intentional-skip")));

  const rule =
    "PR body must contain exactly one `User-Facing:` line -- a plain sentence or `User-Facing: none`.";
  const failureComment = buildSignalComment({
    headSha: HEAD_SHA,
    admission: { ok: false, code: "delivery-contract", message: rule },
  });
  assert.match(failureComment, /Verletzte Regel:/);
  assert.ok(failureComment.includes(`> ${rule}`), "the admission rule must be quoted verbatim");
  assert.match(failureComment, /bleibt rot/);
  assert.match(failureComment, new RegExp(signalMarker(HEAD_SHA, "delivery-contract")));
});

test("a draft is red until ready while other intentional skips remain green", () => {
  assert.equal(
    decideAdmissionEnforcement({
      intentAction: "skip",
      intentCode: "draft",
      admissionOutcome: "skipped",
    }).ok,
    false,
  );
  assert.equal(
    decideAdmissionEnforcement({
      intentAction: "skip",
      intentCode: "measurement-only",
      admissionOutcome: "skipped",
    }).ok,
    true,
  );
  assert.equal(
    decideAdmissionEnforcement({ intentAction: "admit", admissionOutcome: "failure" }).ok,
    false,
  );

  const script = path.join(__dirname, "hans-review-signal.cjs");
  const draft = spawnSync(process.execPath, [script, "enforce"], {
    encoding: "utf8",
    input: JSON.stringify({
      intentAction: "skip",
      intentCode: "draft",
      admissionOutcome: "skipped",
    }),
  });
  const brokenReadyPr = spawnSync(process.execPath, [script, "enforce"], {
    encoding: "utf8",
    input: JSON.stringify({ intentAction: "admit", admissionOutcome: "failure" }),
  });
  assert.equal(draft.status, 1);
  assert.match(draft.stdout, /has not been reviewed/);
  assert.equal(brokenReadyPr.status, 1);
  assert.match(brokenReadyPr.stdout, /::error::Review admission failed/);
});

test("the draft-to-ready lifecycle releases review admission on the same head", () => {
  const draftDecision = decideReviewPreflight({ ...REVIEW_CANDIDATE, draft: true });
  const readyDecision = decideReviewPreflight({ ...REVIEW_CANDIDATE, draft: false });

  const draft = decideAdmissionEnforcement({
    intentAction: draftDecision.action,
    intentCode: draftDecision.code,
    admissionOutcome: "skipped",
  });
  const ready = decideAdmissionEnforcement({
    intentAction: readyDecision.action,
    intentCode: readyDecision.code,
    admissionOutcome: "success",
  });

  assert.equal(draft.ok, false, "an unreviewed draft must not leave a green request-review check");
  assert.equal(ready.ok, true, "the same head is admissible after ready_for_review");
});

test("a pre-admission failure reports the workflow failure instead of promising a PR comment", () => {
  const result = decideAdmissionEnforcement({
    intentAction: "admit",
    admissionOutcome: "skipped",
  });
  assert.doesNotMatch(
    result.annotation,
    /posted on the pull request/,
    "a pre-admission failure must not claim that a PR comment exists",
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "admission-not-run");
  assert.match(result.annotation, /earlier failed workflow step/);
});

test("comment markers deduplicate reruns of the same outcome and SHA", () => {
  const existing = [
    { body: buildSignalComment({ headSha: HEAD_SHA, decision: { action: "skip", reason: "draft" } }) },
  ];
  assert.equal(hasSignalComment(existing, HEAD_SHA, "intentional-skip"), true);
  assert.equal(hasSignalComment(existing, HEAD_SHA, "delivery-contract"), false);
  assert.equal(hasSignalComment(existing, "b".repeat(40), "intentional-skip"), false);
});

test("workflow keeps admission as the red enforcement boundary after preflight", () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, "..", ".github", "workflows", "hans-friedrich.yml"),
    "utf8",
  );
  const preflight = workflow.indexOf("name: Classify review intent");
  const admission = workflow.indexOf("name: Check review admission");
  const comment = workflow.indexOf("name: Explain review outcome on the PR");
  const enforce = workflow.indexOf("name: Enforce review admission");

  assert.ok(preflight >= 0 && preflight < admission);
  assert.ok(admission < comment && comment < enforce);
  assert.match(workflow, /continue-on-error: true/);
  assert.match(workflow, /steps\.admission\.outcome == 'failure'/);
  assert.match(workflow, /hans-review-signal\.cjs enforce/);
  assert.match(workflow, /delimiter="ADMISSION_RESULT_\$\(openssl rand -hex 16\)"/);
  assert.match(workflow, /uses: \.\/\.github\/actions\/hans-review-intent/);
  assert.doesNotMatch(workflow, /node scripts\/hans-review-signal\.cjs preflight/);
  assert.doesNotMatch(workflow, /request-review:\n\s+if:/);
  assert.match(workflow, /types: \[opened, ready_for_review, edited\]/);
  assert.match(
    workflow,
    /github\.event\.pull_request\.draft && 'draft' \|\| 'ready'/,
    "draft skips must not share the ready admission concurrency group",
  );
  assert.match(workflow, /INTENT_CODE: \$\{\{ steps\.intent\.outputs\.code \}\}/);
});

function assertTrustedBaseCheckout(workflow) {
  const checkout = workflow.match(
    /- uses: actions\/checkout@v4\n[\s\S]*?(?=\n\s+- name: Classify review intent)/,
  )?.[0];
  assert.ok(checkout, "the trusted checkout block must be present");
  assert.doesNotMatch(
    checkout,
    /pull_request\.head\.sha/,
    "the trusted checkout must never execute pull-request head code",
  );
  assert.match(checkout, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
}

test("pull_request_target companion only comments from trusted base code", () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, "..", ".github", "workflows", "hans-friedrich-signal.yml"),
    "utf8",
  );
  assert.match(workflow, /pull_request_target:/);
  assert.match(workflow, /pull-requests: write/);
  assertTrustedBaseCheckout(workflow);
  const regressedWorkflow = workflow.replace(
    "ref: ${{ github.event.pull_request.base.sha }}",
    "ref: ${{ github.event.pull_request.head.sha }}",
  );
  assert.throws(
    () => assertTrustedBaseCheckout(regressedWorkflow),
    /the trusted checkout must never execute pull-request head code/,
  );
  assert.match(workflow, /uses: \.\/\.github\/actions\/hans-review-intent/);
  assert.doesNotMatch(workflow, /node scripts\/hans-review-signal\.cjs preflight/);
  assert.doesNotMatch(workflow, /MULTICA_REVIEW_WEBHOOK/);
});
