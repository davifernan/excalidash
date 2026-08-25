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
  userFacing = "none",
  changeKind = userFacing === "none" ? "none" : "changed",
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
User-Facing: ${userFacing}
Change-Kind: ${changeKind}

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

test("versioned operations assets are classified as operations", () => {
  const manifest = impact([
    "ops/systemd/excalidash-pipeline-sentinel.service",
    "ops/systemd/excalidash-pipeline-sentinel.timer",
  ]);

  assert.deepEqual(manifest.diff.operations, [
    "ops/systemd/excalidash-pipeline-sentinel.service",
    "ops/systemd/excalidash-pipeline-sentinel.timer",
  ]);
  assert.equal(manifest.effective.operations, true);
  assert.equal(manifest.diff.other.length, 0);
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

test("PR admission surfaces a real User-Facing sentence and accepts the none escape hatch", () => {
  const manifest = impact([]);

  const withSentence = checkPrAdmission({
    body: prBody({ userFacing: "Boards can now be starred and pinned to the top of the dashboard." }),
    impactManifest: manifest,
  });
  assert.equal(withSentence.ok, true);
  assert.equal(withSentence.userFacing, "Boards can now be starred and pinned to the top of the dashboard.");

  const withNone = checkPrAdmission({ body: prBody({ userFacing: "none" }), impactManifest: manifest });
  assert.equal(withNone.ok, true);
  assert.equal(withNone.userFacing, "none");
});

test("PR admission rejects a missing User-Facing line", () => {
  const withoutLine = prBody().replace(/\nUser-Facing: none/, "");
  const result = checkPrAdmission({ body: withoutLine, impactManifest: impact([]) });
  assert.equal(result.code, "delivery-contract");
  assert.match(result.message, /exactly one `User-Facing:` line/);
});

test("RED: User-Facing rejects ticket and PR number references (NIL-507, Davi's hard rule)", () => {
  const manifest = impact([]);

  const ticket = checkPrAdmission({
    body: prBody({ userFacing: "Fixes the bug from NIL-292 with favorites." }),
    impactManifest: manifest,
  });
  assert.equal(ticket.code, "delivery-contract");
  assert.match(ticket.message, /must not reference a ticket or PR number/);

  const prNumber = checkPrAdmission({
    body: prBody({ userFacing: "Ships the dashboard work from #75." }),
    impactManifest: manifest,
  });
  assert.equal(prNumber.code, "delivery-contract");
  assert.match(prNumber.message, /must not reference a ticket or PR number/);

  // A plain "#" used as a heading marker or count, not a PR reference, must
  // stay legal -- the check targets "#<digits>", not the character alone.
  const hashNotNumber = checkPrAdmission({
    body: prBody({ userFacing: "Search now matches board titles starting with #." }),
    impactManifest: manifest,
  });
  assert.equal(hashNotNumber.ok, true);
});

test("PR admission surfaces Change-Kind, and requires it to agree with User-Facing (NIL-577)", () => {
  const manifest = impact([]);

  const added = checkPrAdmission({
    body: prBody({ userFacing: "Boards can now be starred.", changeKind: "added" }),
    impactManifest: manifest,
  });
  assert.equal(added.ok, true);
  assert.equal(added.changeKind, "added");

  const none = checkPrAdmission({ body: prBody(), impactManifest: manifest });
  assert.equal(none.ok, true);
  assert.equal(none.changeKind, "none");
});

test("PR admission rejects a missing Change-Kind line", () => {
  const withoutLine = prBody().replace(/\nChange-Kind: none/, "");
  const result = checkPrAdmission({ body: withoutLine, impactManifest: impact([]) });
  assert.equal(result.code, "delivery-contract");
  assert.match(result.message, /exactly one `Change-Kind:` line/);
});

test("PR admission rejects an unsupported Change-Kind value", () => {
  const result = checkPrAdmission({
    body: prBody({ userFacing: "Boards can now be starred.", changeKind: "feature" }),
    impactManifest: impact([]),
  });
  assert.equal(result.code, "delivery-contract");
  assert.match(result.message, /exactly one `Change-Kind:` line/);
});

test("RED: Change-Kind: none is only valid alongside User-Facing: none -- it cannot excuse a real change from categorizing", () => {
  const result = checkPrAdmission({
    body: prBody({ userFacing: "Boards can now be starred.", changeKind: "none" }),
    impactManifest: impact([]),
  });
  assert.equal(result.code, "delivery-contract");
  assert.match(result.message, /must declare a real `Change-Kind:`/);
});

test("RED: a real Change-Kind cannot be declared once User-Facing has opted out with none", () => {
  const result = checkPrAdmission({
    body: prBody({ userFacing: "none", changeKind: "added" }),
    impactManifest: impact([]),
  });
  assert.equal(result.code, "delivery-contract");
  assert.match(result.message, /Change-Kind must be `none` when User-Facing is `none`/);
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

test("an invalid Package-Session names where the real UUID lives, not just that the ULID form is wrong (NIL-417)", () => {
  const ulidBody = prBody().replace(OWNER_SESSION, "session_01HLU4ZSv13YSZbKgRLRWNBf");
  assert.throws(
    () => parsePrDeliveryContract(ulidBody),
    /~\/\.claude\/projects\/<project>\/<uuid>\.jsonl/,
  );

  // A body with a real UUID still passes -- the fix only enriches the message.
  assert.equal(parsePrDeliveryContract(prBody()).packageSession, OWNER_SESSION);
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

test("ready-gate labels stay exact while tolerating checked-case, suffixes, and right whitespace", () => {
  const altered = prBody({
    gates: [
      "- [x] Multica HANDOFF posted for this head",
      "- [X] Local verification complete",
      "- [x] Ready for Hans-Friedrich ",
    ],
  });
  const result = checkPrAdmission({ body: altered, impactManifest: impact([]) });

  assert.equal(result.code, "ready");

  const changedLabelCase = checkPrAdmission({
    body: prBody().replace("Multica HANDOFF posted", "Multica Handoff posted"),
    impactManifest: impact([]),
  });
  assert.equal(changedLabelCase.code, "ready-gate");
  assert.match(changedLabelCase.message, /exact label/);

  const unchecked = checkPrAdmission({
    body: prBody().replace("- [x] Local verification", "- [ ] Local verification"),
    impactManifest: impact([]),
  });
  assert.equal(unchecked.code, "ready-gate");

  const semanticAlias = checkPrAdmission({
    body: prBody().replace(
      "Ready for Hans-Friedrich",
      "Hans-Friedrich completed the one general review",
    ),
    impactManifest: impact([]),
  });
  assert.equal(semanticAlias.code, "ready-gate");
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

  // The rule is "a code push never re-reviews", not "this list has exactly two
  // entries" (NIL-585). Pinning the literal list made the guard fail on a
  // change that does not touch the rule at all -- so it is anchored to the two
  // things that actually matter instead.
  assert.doesNotMatch(workflow, /types: \[[^\]]*synchronize/);

  // The one-shot contract is enforced per HEAD, not per event (NIL-585, after
  // Hans's finding on #152). Blocking `edited` outright left a corrected PR
  // sitting behind a stale failure comment with no way forward but the
  // undocumented ready-toggle -- so the guard asks "was this head reviewed
  // already?" instead of "which event was this?".
  assert.match(
    workflow,
    /Ask Multica for a review\n\s*if: steps\.admission\.outcome == 'success' && steps\.reviewed\.outputs\.already != 'true'/,
  );
  assert.match(workflow, /review\.commit_id === process\.env\.HEAD_SHA/);

  // A correction that now passes must say so, or the superseded failure
  // comment stays as the last visible word on the PR.
  assert.match(workflow, /name: Confirm the corrected body passed/);
});

test("PR admission reports every violation in one pass, not just the first (NIL-585)", () => {
  const manifest = impact(["scripts/delivery-v2.cjs"]);

  // The real shape of PR #146 on 25.08.2026: an unchecked ready-gate box AND a
  // Visual-Evidence value that contradicts the diff. Before NIL-585 the first
  // one hid the second, so fixing it only revealed the next round.
  const result = checkPrAdmission({
    body: prBody({
      visualEvidence: VISUAL_EVIDENCE.PROVIDED,
      gates: ["- [x] Multica HANDOFF posted", "- [x] Local verification complete"],
    }),
    impactManifest: manifest,
  });

  assert.equal(result.ok, false);
  const codes = result.findings.map((finding) => finding.code).sort();
  assert.deepEqual(codes, ["ready-gate", "visual-evidence"]);

  // `code`/`message` keep reporting the first finding so the workflow's signal
  // comment and every existing consumer stay unchanged.
  assert.equal(result.code, result.findings[0].code);
  assert.equal(result.message, result.findings[0].message);
});

test("a broken delivery contract still surfaces the ready-gate finding beneath it (NIL-585)", () => {
  const manifest = impact([]);

  // PR #146 again: an invented Package-Session made `parsePrDeliveryContract`
  // throw, which used to return immediately -- hiding the unchecked box until
  // a later round. Visual-Evidence stays unreported here on purpose: with no
  // parsed contract there is no received value to compare, and inventing one
  // would be a guess rather than a finding.
  const result = checkPrAdmission({
    body: prBody({ gates: ["- [x] Multica HANDOFF posted"] }).replace(
      /^Package-Session: .*$/m,
      "Package-Session: not-a-uuid",
    ),
    impactManifest: manifest,
  });

  assert.equal(result.ok, false);
  const codes = result.findings.map((finding) => finding.code).sort();
  assert.deepEqual(codes, ["delivery-contract", "ready-gate"]);
});
