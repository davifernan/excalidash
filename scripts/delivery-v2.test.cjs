"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  MAX_ACTIVE_SESSIONS,
  VISUAL_EVIDENCE,
  buildImpactManifest,
  checkPrAdmission,
  parsePrDeliveryContract,
  planPackageClaim,
  planReleaseQa,
  routeExecutionUnit,
} = require("./delivery-v2.cjs");

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const OWNER_SESSION = "01a02bc5-fe01-7ce3-b520-387137968d9a";

function packageIssue(metadata = {}) {
  return {
    identifier: "NIL-404",
    metadata: {
      pipeline_schema_version: "2",
      delivery_model: "ownership_package",
      execution_unit: true,
      package_status: "unclaimed",
      ...metadata,
    },
  };
}

function acceptanceSlice() {
  return {
    identifier: "NIL-331",
    metadata: {
      pipeline_schema_version: "2",
      delivery_model: "acceptance_slice",
      execution_unit: false,
      parent_package: "NIL-322",
    },
  };
}

function ownerMetadata() {
  return {
    package_status: "implementing",
    package_owner_agent_id: "agent-1",
    package_owner_session_id: OWNER_SESSION,
    package_worktree: "/workspace/nil-404",
  };
}

function prBody({
  visualEvidence = VISUAL_EVIDENCE.NON_VISIBLE_SKIP,
  slices = "none",
  gates = [
    "- [x] Multica HANDOFF posted",
    "- [x] Local verification complete",
    "- [x] Ready for Hans-Friedrich",
  ],
} = {}) {
  return `Multica-Package: NIL-404
Delivery-Slices: ${slices}
Package-Session: ${OWNER_SESSION}
Impact-Manifest: generated from git diff
Visual-Evidence: ${visualEvidence}

## Ready gate

${gates.join("\n")}
`;
}

function impact(files, labels = []) {
  return buildImpactManifest({ baseSha: BASE_SHA, headSha: HEAD_SHA, files, labels });
}

test("rejects an acceptance slice before any trigger can dispatch it", () => {
  assert.deepEqual(
    routeExecutionUnit({
      issue: acceptanceSlice(),
      trigger: { kind: "package_dispatch", event_id: "dispatch-1" },
    }),
    {
      ok: false,
      dispatch: false,
      code: "not-execution-unit",
      reason: "NIL-331 has execution_unit=false and cannot dispatch an implementer.",
      identifier: "NIL-331",
      deliveryModel: "acceptance_slice",
      owner: null,
    },
  );
});

test("admits a valid ownership package through the same routing path", () => {
  const result = routeExecutionUnit({
    issue: packageIssue(),
    trigger: { kind: "package_dispatch", event_id: "dispatch-1" },
  });

  assert.equal(result.dispatch, true);
  assert.equal(result.code, "claimable");
  assert.equal(result.idempotencyKey, "NIL-404:package_dispatch:dispatch-1");
  assert.equal(result.maxActiveSessions, 12);
});

test("an ownership package can be claimed only once", () => {
  const claimed = packageIssue(ownerMetadata());
  const secondDispatch = routeExecutionUnit({
    issue: claimed,
    trigger: { kind: "package_dispatch", event_id: "dispatch-2" },
  });

  assert.equal(secondDispatch.dispatch, false);
  assert.equal(secondDispatch.code, "already-owned");
  assert.match(secondDispatch.reason, new RegExp(OWNER_SESSION));
});

test("partial owner metadata fails closed instead of becoming claimable", () => {
  const result = routeExecutionUnit({
    issue: packageIssue({ package_owner_agent_id: "agent-1" }),
    trigger: { kind: "package_dispatch", event_id: "dispatch-2" },
  });

  assert.equal(result.dispatch, false);
  assert.equal(result.code, "owner-record-invalid");
});

test("ordinary comments never duplicate a package-owner run", () => {
  const result = routeExecutionUnit({
    issue: packageIssue(ownerMetadata()),
    trigger: { kind: "ordinary_comment", event_id: "comment-1" },
  });

  assert.equal(result.dispatch, false);
  assert.equal(result.code, "comment-does-not-dispatch");
});

test("owner continuations stay bound to the canonical package session", () => {
  const issue = packageIssue(ownerMetadata());
  const resumed = routeExecutionUnit({
    issue,
    trigger: {
      kind: "owner_resume",
      event_id: "slice-2",
      owner_session_id: OWNER_SESSION,
    },
  });
  const stolen = routeExecutionUnit({
    issue,
    trigger: {
      kind: "finding_fix",
      event_id: "finding-1",
      owner_session_id: "01a02bc5-fe01-7ce3-b520-000000000000",
    },
  });

  assert.equal(resumed.dispatch, true);
  assert.equal(resumed.code, "owner-routed");
  assert.equal(resumed.owner.session_id, OWNER_SESSION);
  assert.equal(stolen.dispatch, false);
  assert.equal(stolen.code, "owner-mismatch");
});

test("claim planning produces the canonical package metadata in one transition", () => {
  const result = planPackageClaim({
    issue: packageIssue(),
    claim: {
      event_id: "dispatch-1",
      agent_id: "agent-1",
      session_id: OWNER_SESSION,
      worktree: "/workspace/nil-404",
      current_slice: "NIL-404/PR1",
    },
  });

  assert.equal(result.dispatch, true);
  assert.deepEqual(result.claim, {
    package_owner_agent_id: "agent-1",
    package_owner_session_id: OWNER_SESSION,
    package_worktree: "/workspace/nil-404",
    current_slice: "NIL-404/PR1",
    package_status: "implementing",
  });
  assert.equal(MAX_ACTIVE_SESSIONS, 12);
});

test("git diff overrides a stale frontend label", () => {
  const manifest = impact(["backend/src/index.ts"], ["frontend", "backend"]);

  assert.equal(manifest.labels.frontend, true);
  assert.equal(manifest.effective.frontend, false);
  assert.equal(manifest.effective.backend, true);
  assert.equal(manifest.effective.label_overridden_by_diff, true);
  assert.equal(manifest.visual_evidence.required, false);
  assert.equal(manifest.browser_scope, "none");
});

test("a frontend product diff requires visual evidence even without a label", () => {
  const manifest = impact(["frontend/src/pages/Dashboard.tsx"], []);

  assert.equal(manifest.effective.frontend_product, true);
  assert.equal(manifest.effective.label_overridden_by_diff, true);
  assert.deepEqual(manifest.visual_evidence, {
    required: true,
    decision: "required",
    reason: "frontend-product-diff",
  });
  assert.equal(manifest.browser_scope, "targeted-visible-flow");
});

test("test-only frontend changes receive an explicit screenshot skip", () => {
  const manifest = impact([
    "frontend/src/pages/Dashboard.test.tsx",
    "e2e/tests/dashboard.spec.ts",
  ]);

  assert.equal(manifest.effective.frontend_test_only, true);
  assert.equal(manifest.visual_evidence.reason, "test-only-frontend-diff");
  assert.equal(manifest.browser_scope, "none");
});

test("PR admission requires one package, its slices, session, manifest, and exact gates", () => {
  const manifest = impact(["scripts/delivery-v2.cjs"]);
  const result = checkPrAdmission({ body: prBody(), impactManifest: manifest });

  assert.equal(result.ok, true);
  assert.equal(result.primaryPackage, "NIL-404");
  assert.deepEqual(result.deliverySlices, []);
  assert.equal(result.packageSession, OWNER_SESSION);
});

test("PR admission parses unique Delivery Slices and rejects a second package", () => {
  assert.deepEqual(
    parsePrDeliveryContract(prBody({ slices: "NIL-331, NIL-332" })).deliverySlices,
    ["NIL-331", "NIL-332"],
  );

  const duplicatePackage = `${prBody()}\nMultica-Package: NIL-405\n`;
  assert.match(
    checkPrAdmission({ body: duplicatePackage, impactManifest: impact([]) }).message,
    /exactly one `Multica-Package/,
  );
});

test("PR admission rejects drafts, bots, placeholders, and incomplete package bodies", () => {
  const manifest = impact([]);

  assert.equal(
    checkPrAdmission({ body: prBody(), draft: true, impactManifest: manifest }).code,
    "draft",
  );
  assert.equal(
    checkPrAdmission({ body: prBody(), authorType: "Bot", impactManifest: manifest }).code,
    "bot",
  );
  assert.equal(
    checkPrAdmission({
      body: prBody().replace("NIL-404", "NIL-000"),
      impactManifest: manifest,
    }).code,
    "delivery-contract",
  );
  assert.equal(
    checkPrAdmission({ body: "Multica-Package: NIL-404", impactManifest: manifest }).code,
    "delivery-contract",
  );
});

test("the three ready-gate lines are compared character-for-character", () => {
  const altered = prBody({
    gates: [
      "- [x] Multica HANDOFF posted for this head",
      "- [x] Local verification complete",
      "- [x] Ready for Hans-Friedrich",
    ],
  });
  const result = checkPrAdmission({ body: altered, impactManifest: impact([]) });

  assert.equal(result.ok, false);
  assert.equal(result.code, "ready-gate");
  assert.match(result.message, /- \[x\] Multica HANDOFF posted/);

  const changedCase = checkPrAdmission({
    body: prBody().replace("Multica HANDOFF posted", "Multica Handoff posted"),
    impactManifest: impact([]),
  });
  assert.equal(changedCase.code, "ready-gate");
});

test("frontend product admission rejects a visual-evidence skip", () => {
  const result = checkPrAdmission({
    body: prBody({ visualEvidence: VISUAL_EVIDENCE.NON_VISIBLE_SKIP }),
    impactManifest: impact(["frontend/src/App.tsx"]),
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "visual-evidence");
  assert.match(result.message, /must be `provided`/);
});

test("frontend product admission passes with visual evidence", () => {
  const result = checkPrAdmission({
    body: prBody({ visualEvidence: VISUAL_EVIDENCE.PROVIDED }),
    impactManifest: impact(["frontend/src/App.tsx"]),
  });

  assert.equal(result.ok, true);
  assert.equal(result.visualEvidence.required, true);
});

test("test-only frontend admission requires the test-only skip reason", () => {
  const manifest = impact(["frontend/src/App.test.tsx"]);
  const wrong = checkPrAdmission({ body: prBody(), impactManifest: manifest });
  const right = checkPrAdmission({
    body: prBody({ visualEvidence: VISUAL_EVIDENCE.TEST_ONLY_SKIP }),
    impactManifest: manifest,
  });

  assert.equal(wrong.ok, false);
  assert.equal(wrong.code, "visual-evidence");
  assert.equal(right.ok, true);
});

test("release QA is due at three integrations and preserves the anchor range", () => {
  const result = planReleaseQa({
    lastQaSha: BASE_SHA,
    currentMainSha: HEAD_SHA,
    integrationsSinceQa: 3,
    packageComplete: false,
    highRisk: false,
    releaseTag: false,
    impactManifests: [impact(["backend/src/index.ts"])],
  });

  assert.equal(result.required, true);
  assert.deepEqual(result.reasons, ["three-integrations"]);
  assert.equal(result.range, `${BASE_SHA}..${HEAD_SHA}`);
  assert.equal(result.visual_evidence.required, false);
  assert.equal(result.create_qa_issues, false);
});

test("package completion, high risk, and release tags independently trigger QA", () => {
  for (const flag of ["packageComplete", "highRisk", "releaseTag"]) {
    const input = {
      lastQaSha: BASE_SHA,
      currentMainSha: HEAD_SHA,
      integrationsSinceQa: 0,
      packageComplete: false,
      highRisk: false,
      releaseTag: false,
      impactManifests: [impact(["frontend/src/App.tsx"])],
    };
    input[flag] = true;
    const result = planReleaseQa(input);
    assert.equal(result.required, true, flag);
    assert.equal(result.visual_evidence.required, true, flag);
    assert.equal(result.delivery, "package-comment", flag);
  }
});

test("a normal integration below the checkpoint does not create release QA", () => {
  const result = planReleaseQa({
    lastQaSha: BASE_SHA,
    currentMainSha: HEAD_SHA,
    integrationsSinceQa: 2,
    packageComplete: false,
    highRisk: false,
    releaseTag: false,
    impactManifests: [impact(["scripts/delivery-v2.cjs"])],
  });

  assert.equal(result.required, false);
  assert.deepEqual(result.reasons, []);
});

test("Hans is not retriggered on finding-fix pushes", () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, "..", ".github", "workflows", "hans-friedrich.yml"),
    "utf8",
  );

  assert.match(workflow, /types: \[opened, ready_for_review\]/);
  assert.doesNotMatch(workflow, /types: \[[^\]]*synchronize/);
});
