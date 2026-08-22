"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  acquireLock,
  attemptPackageRecovery,
  classifyPackage,
  executablePackages,
  fingerprint,
  hansAnomaly,
  hasCurrentHansReview,
  observe,
  qaDue,
  recordAction,
} = require("./pipeline-sentinel.cjs");

const SHA = "a".repeat(40);

function issue(overrides = {}) {
  return {
    identifier: "NIL-404",
    status: "in_progress",
    assignee_id: "agent-1",
    metadata: { execution_unit: true, depends_on: "none" },
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    issue: issue(),
    runs: [],
    pullRequests: [],
    mainSha: SHA,
    ...overrides,
  };
}

test("in_progress without a live run, open PR or lease is stalled", () => {
  const result = classifyPackage(snapshot({
    runs: [{ id: "cancelled-run", status: "cancelled", created_at: "2026-08-22T23:00:00Z" }],
  }));
  assert.equal(result.active, false);
  assert.equal(result.anomaly, "stalled-package");
  assert.equal(result.action, "rerun-package-owner");
});

test("a completed comment task to a dead fixer is not mistaken for activity", () => {
  const result = classifyPackage(snapshot({
    runs: [{ id: "comment-task", kind: "comment", status: "completed", created_at: "2026-08-22T23:00:00Z" }],
  }));
  assert.equal(result.active, false);
  assert.equal(result.action, "rerun-package-owner");
});

test("each accepted activity signal independently keeps a package healthy", () => {
  assert.equal(classifyPackage(snapshot({ runs: [{ id: "r1", status: "running" }] })).active, true);
  assert.equal(classifyPackage(snapshot({ pullRequests: [{ number: 41, state: "open" }] })).active, true);
  assert.equal(classifyPackage(snapshot({ pullRequests: [{ number: 42, state: "draft" }] })).active, true);
  assert.equal(classifyPackage(snapshot({
    issue: issue({ metadata: { controller_lease_expires_at: "2099-01-01T00:00:00Z" } }),
  }), Date.parse("2026-08-22T23:00:00Z")).active, true);
});

test("fingerprint includes the run, PR head and main head", () => {
  const first = fingerprint(snapshot({ runs: [{ id: "r1", status: "cancelled" }] }));
  const second = fingerprint(snapshot({ runs: [{ id: "r2", status: "cancelled" }] }));
  const third = fingerprint(snapshot({ mainSha: "b".repeat(40) }));
  assert.notEqual(first, second);
  assert.notEqual(first, third);
});

test("a recovery requires two identical observations and stops after two attempts", () => {
  const state = { observations: {}, incidents: {} };
  assert.deepEqual(observe(state, "package:NIL-404", "same", "2026-08-22T23:00:00Z"), {
    shouldAct: false,
    observations: 1,
  });
  assert.equal(observe(state, "package:NIL-404", "same", "2026-08-22T23:03:00Z").shouldAct, true);
  assert.equal(recordAction(state, "package:NIL-404", "2026-08-22T23:03:00Z"), 1);
  assert.equal(observe(state, "package:NIL-404", "same", "2026-08-22T23:06:00Z").shouldAct, true);
  assert.equal(recordAction(state, "package:NIL-404", "2026-08-22T23:06:00Z"), 2);
  const exhausted = observe(state, "package:NIL-404", "same", "2026-08-22T23:09:00Z");
  assert.equal(exhausted.shouldAct, false);
  assert.equal(exhausted.exhausted, true);
});

test("singleflight permits exactly one actor to own the same recovery", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-lock-"));
  const lock = path.join(root, "same.lock");
  const firstRelease = acquireLock(lock);
  const secondRelease = acquireLock(lock);
  assert.equal(typeof firstRelease, "function");
  assert.equal(secondRelease, null);
  firstRelease();
  assert.equal(typeof acquireLock(lock), "function");
});

test("pre-mutation re-read suppresses a rerun created by another controller", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-race-"));
  let reruns = 0;
  const initial = snapshot({ runs: [{ id: "old", status: "cancelled" }] });
  const adapter = {
    getIssue: () => initial.issue,
    getRuns: () => [{ id: "other-controller", status: "queued" }],
    getPullRequests: () => [],
    getMainSha: () => SHA,
    rerun: () => { reruns += 1; },
  };
  const result = await attemptPackageRecovery({
    adapter,
    config: {},
    issue: initial.issue,
    expectedFingerprint: fingerprint(initial),
    lockRoot: root,
    dryRun: false,
  });
  assert.equal(result.result, "already-recovered");
  assert.equal(reruns, 0);
});

test("only dependency-complete, unclaimed execution packages are eligible", () => {
  const packages = [
    issue({ identifier: "NIL-404", status: "done", assignee_id: null }),
    issue({ identifier: "NIL-321", status: "backlog", assignee_id: null, metadata: { execution_unit: true, depends_on: "NIL-404" } }),
    issue({ identifier: "NIL-322", status: "backlog", assignee_id: null, metadata: { execution_unit: false, depends_on: "none" } }),
  ];
  assert.deepEqual(executablePackages(packages).map((candidate) => candidate.identifier), ["NIL-321"]);
});

test("Hans recovery waits for a ready, stable head and accepts only a matching bot review", () => {
  const pr = {
    number: 41,
    isDraft: false,
    body: "Multica-Package: NIL-404\n\n- [x] Ready for Hans-Friedrich",
    headRefOid: SHA,
    updatedAt: "2026-08-22T22:00:00Z",
  };
  assert.equal(hansAnomaly(pr, [], Date.parse("2026-08-22T23:00:00Z")).action, "trigger-hans");
  const reviews = [{
    user: { login: "the-hans-friedrich[bot]" },
    commit_id: SHA,
    body: `<!-- excalidash-review:v1 {"reviewed_head_sha":"${SHA}"} -->`,
  }];
  assert.equal(hasCurrentHansReview(reviews, SHA), true);
  assert.equal(hansAnomaly(pr, reviews, Date.parse("2026-08-22T23:00:00Z")), null);
});

test("QA becomes due from the checkpoint counter or explicit package state", () => {
  assert.equal(qaDue({ metadata: { qa_prs_since_anchor: 3, qa_checkpoint_max_prs: 3 } }, [], SHA), true);
  assert.equal(qaDue({ metadata: { qa_prs_since_anchor: 0 } }, [
    issue({ metadata: { package_status: "awaiting_qa", last_qa_sha: "b".repeat(40) } }),
  ], SHA), true);
  assert.equal(qaDue({ metadata: { qa_prs_since_anchor: 0 } }, [], SHA), false);
});
