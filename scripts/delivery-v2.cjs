#!/usr/bin/env node

"use strict";

const { execFileSync } = require("node:child_process");

const IDENTIFIER_PATTERN = /^NIL-[1-9][0-9]*$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SESSION_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const PIPELINE_SCHEMA_VERSION = "2";
const OWNERSHIP_PACKAGE = "ownership_package";
const ACCEPTANCE_SLICE = "acceptance_slice";
const MAX_ACTIVE_SESSIONS = 12;
const ROUTING_TRIGGERS = new Set([
  "package_dispatch",
  "owner_resume",
  "finding_fix",
  "qa_followup",
]);
const READY_GATE_LINES = [
  "- [x] Multica HANDOFF posted",
  "- [x] Local verification complete",
  "- [x] Ready for Hans-Friedrich",
];
const VISUAL_EVIDENCE = Object.freeze({
  PROVIDED: "provided",
  TEST_ONLY_SKIP: "skipped: test-only frontend delta",
  NON_VISIBLE_SKIP: "skipped: no visible frontend product delta",
});
const USER_FACING_NONE = "none";
// Release-notes categorization used to be guessed from a PR's commit-subject
// history (scripts/release-notes-collect.cjs, categorize()) -- a majority
// vote of `feat:`/`fix:` prefixes across the branch. That measures how a
// branch was BUILT, not what it IS for a user: PR #138 (NIL-567, the
// Markdown editor) carried zero conventionally-prefixed feat commits and
// three fix commits picked up along the way, so the vote said "Fixed" for a
// brand-new feature. Nobody else in the PR body knows the answer either --
// the implementer does, at the moment they write it. So it is asked for
// directly, the same way `User-Facing:` already is (NIL-577).
const CHANGE_KIND = Object.freeze({
  ADDED: "added",
  FIXED: "fixed",
  CHANGED: "changed",
  NONE: "none",
});
// A release note that names NIL-292 or #75 is useless to anyone reading it --
// nobody outside this Multica project has an account, and a bare number
// carries no meaning. This is the one line in the whole contract whose
// AUDIENCE is not the reviewer or the pipeline but a person who will never
// see a ticket tracker, so it is checked for that leak rather than just for
// presence (NIL-507, Davi 24.08.2026).
const TICKET_REFERENCE_PATTERN = /\bNIL-\d+\b|(?:^|[^\w])#\d+\b/i;

function routeExecutionUnit({ issue, trigger = {} }) {
  const identifier = normalizeIdentifier(issue?.identifier);
  const metadata = issue?.metadata || {};
  const deliveryModel = metadata.delivery_model;

  if (metadata.execution_unit !== true) {
    return rejectedRoute(
      "not-execution-unit",
      `${identifier} has execution_unit=${String(metadata.execution_unit)} and cannot dispatch an implementer.`,
      identifier,
      deliveryModel,
    );
  }
  if (deliveryModel !== OWNERSHIP_PACKAGE) {
    return rejectedRoute(
      "not-ownership-package",
      `${identifier} has delivery_model=${String(deliveryModel)}; only ownership_package is dispatchable.`,
      identifier,
      deliveryModel,
    );
  }
  if (String(metadata.pipeline_schema_version) !== PIPELINE_SCHEMA_VERSION) {
    return rejectedRoute(
      "pipeline-schema",
      `${identifier} is not on pipeline schema ${PIPELINE_SCHEMA_VERSION}.`,
      identifier,
      deliveryModel,
    );
  }

  const kind = trigger.kind;
  if (kind === "ordinary_comment") {
    return rejectedRoute(
      "comment-does-not-dispatch",
      `Ordinary comments on ${identifier} do not create package-owner runs.`,
      identifier,
      deliveryModel,
    );
  }
  if (!ROUTING_TRIGGERS.has(kind)) {
    return rejectedRoute(
      "unsupported-trigger",
      `Trigger ${String(kind)} is not a Delivery v2 routing trigger.`,
      identifier,
      deliveryModel,
    );
  }
  if (!isNonEmptyString(trigger.event_id)) {
    return rejectedRoute(
      "missing-event-id",
      "Delivery v2 routing requires a stable event_id for idempotency.",
      identifier,
      deliveryModel,
    );
  }

  const owner = readPackageOwner(metadata);
  if (packageOwnerFieldCount(metadata) > 0 && !owner) {
    return rejectedRoute(
      "owner-record-invalid",
      `${identifier} has a partial or invalid canonical package owner record.`,
      identifier,
      deliveryModel,
    );
  }
  if (kind === "package_dispatch") {
    if (owner) {
      return rejectedRoute(
        "already-owned",
        `${identifier} is already owned by session ${owner.session_id}; duplicate package dispatch is forbidden.`,
        identifier,
        deliveryModel,
        owner,
      );
    }
    if (!isUnclaimedStatus(metadata.package_status)) {
      return rejectedRoute(
        "package-not-claimable",
        `${identifier} has package_status=${String(metadata.package_status)} without a complete owner record.`,
        identifier,
        deliveryModel,
      );
    }
    return acceptedRoute(identifier, deliveryModel, kind, trigger.event_id, null, "claimable");
  }

  if (!owner) {
    return rejectedRoute(
      "owner-missing",
      `${identifier} cannot resume because its canonical package owner record is incomplete.`,
      identifier,
      deliveryModel,
    );
  }
  if (trigger.owner_session_id !== owner.session_id) {
    return rejectedRoute(
      "owner-mismatch",
      `${identifier} belongs to session ${owner.session_id}, not ${String(trigger.owner_session_id)}.`,
      identifier,
      deliveryModel,
      owner,
    );
  }

  return acceptedRoute(identifier, deliveryModel, kind, trigger.event_id, owner, "owner-routed");
}

function planPackageClaim({ issue, claim }) {
  if (!claim || !SESSION_PATTERN.test(claim.session_id || "")) {
    throw new Error("Package claim requires a real session_id.");
  }
  if (!isNonEmptyString(claim.agent_id) || !isAbsolutePath(claim.worktree)) {
    throw new Error("Package claim requires agent_id and an absolute package worktree.");
  }
  if (!isNonEmptyString(claim.current_slice)) {
    throw new Error("Package claim requires current_slice.");
  }

  const route = routeExecutionUnit({
    issue,
    trigger: { kind: "package_dispatch", event_id: claim.event_id },
  });
  if (!route.dispatch) return route;

  return {
    ...route,
    claim: {
      package_owner_agent_id: claim.agent_id,
      package_owner_session_id: claim.session_id,
      package_worktree: claim.worktree,
      current_slice: claim.current_slice,
      package_status: "implementing",
    },
  };
}

function checkPrAdmission({ body, draft = false, authorType = "User", impactManifest }) {
  if (draft) {
    return { ok: false, code: "draft", message: "Draft PRs are not review-ready." };
  }
  if (authorType === "Bot") {
    return { ok: false, code: "bot", message: "Bot PRs are not reviewed automatically." };
  }

  let delivery;
  try {
    delivery = parsePrDeliveryContract(body);
  } catch (error) {
    return { ok: false, code: "delivery-contract", message: error.message };
  }

  const lines = (body || "").split(/\r?\n/);
  const checkedLabels = lines.map(parseReadyGateLabel).filter(Boolean);
  const missingChecks = READY_GATE_LINES.filter((required) => {
    const requiredLabel = required.slice("- [x] ".length);
    return !checkedLabels.some(
      (actual) => actual === requiredLabel ||
        actual.startsWith(`${requiredLabel} `) ||
        actual.startsWith(`${requiredLabel}\t`),
    );
  });
  if (missingChecks.length > 0) {
    return {
      ok: false,
      code: "ready-gate",
      message:
        "Review admission requires checked line(s) beginning with the exact label(s): " +
        `${missingChecks.join(", ")}.`,
    };
  }

  try {
    validateImpactManifest(impactManifest);
  } catch (error) {
    return { ok: false, code: "impact-manifest", message: error.message };
  }

  const expectedVisualEvidence = expectedVisualEvidenceValue(impactManifest);
  if (delivery.visualEvidence !== expectedVisualEvidence) {
    return {
      ok: false,
      code: "visual-evidence",
      message:
        `Visual-Evidence must be \`${expectedVisualEvidence}\` for the generated git diff; ` +
        `received \`${delivery.visualEvidence}\`.`,
    };
  }

  return {
    ok: true,
    code: "ready",
    primaryPackage: delivery.primaryPackage,
    deliverySlices: delivery.deliverySlices,
    packageSession: delivery.packageSession,
    impact: impactManifest.effective,
    visualEvidence: impactManifest.visual_evidence,
    userFacing: delivery.userFacing,
    changeKind: delivery.changeKind,
  };
}

function parseReadyGateLabel(line) {
  const match = /^- \[[xX]\] (.*?)[ \t]*$/.exec(line);
  return match ? match[1] : null;
}

function parsePrDeliveryContract(body) {
  const text = body || "";
  const packages = fieldValues(text, "Multica-Package").map(normalizeIdentifier);
  if (packages.length !== 1) {
    throw new Error("PR body must contain exactly one `Multica-Package: NIL-NNN` line.");
  }

  const sliceFields = fieldValues(text, "Delivery-Slices");
  if (sliceFields.length !== 1) {
    throw new Error("PR body must contain exactly one `Delivery-Slices:` line.");
  }
  const deliverySlices = parseDeliverySlices(sliceFields[0]);
  if (deliverySlices.includes(packages[0])) {
    throw new Error("The primary package cannot also be a Delivery Slice.");
  }

  const sessions = fieldValues(text, "Package-Session");
  if (sessions.length !== 1 || !SESSION_PATTERN.test(sessions[0])) {
    throw new Error(
      "PR body must contain exactly one real `Package-Session:` UUID " +
        "(your session UUID is the filename of your transcript under " +
        "~/.claude/projects/<project>/<uuid>.jsonl -- not the `session_01H...` display form).",
    );
  }

  const manifestDeclarations = fieldValues(text, "Impact-Manifest");
  if (manifestDeclarations.length !== 1 || manifestDeclarations[0] !== "generated from git diff") {
    throw new Error("PR body must declare `Impact-Manifest: generated from git diff`.");
  }

  const evidence = fieldValues(text, "Visual-Evidence");
  if (evidence.length !== 1 || !Object.values(VISUAL_EVIDENCE).includes(evidence[0])) {
    throw new Error("PR body must contain exactly one supported `Visual-Evidence:` decision.");
  }

  const userFacing = fieldValues(text, "User-Facing");
  if (userFacing.length !== 1 || userFacing[0].length === 0) {
    throw new Error(
      "PR body must contain exactly one `User-Facing:` line -- a plain sentence describing " +
        "what a user of ExcaliDash notices, or `User-Facing: none` for a package that only " +
        "changes guards, tests, or internal plumbing.",
    );
  }
  if (userFacing[0] !== USER_FACING_NONE && TICKET_REFERENCE_PATTERN.test(userFacing[0])) {
    throw new Error(
      "User-Facing must not reference a ticket or PR number (no `NIL-NNN`, no `#NNN`) -- " +
        "the release notes generated from this line are read by people with no Multica " +
        "access. Describe what changed in plain language instead.",
    );
  }

  const changeKindFields = fieldValues(text, "Change-Kind");
  if (changeKindFields.length !== 1 || !Object.values(CHANGE_KIND).includes(changeKindFields[0])) {
    throw new Error(
      "PR body must contain exactly one `Change-Kind:` line (`added`, `fixed`, `changed`, or " +
        "`none`) -- release notes categorize a package from this, never guessed from its " +
        "commit history (NIL-577).",
    );
  }
  const changeKind = changeKindFields[0];
  if (userFacing[0] === USER_FACING_NONE && changeKind !== CHANGE_KIND.NONE) {
    throw new Error("Change-Kind must be `none` when User-Facing is `none` -- there is nothing to categorize.");
  }
  if (userFacing[0] !== USER_FACING_NONE && changeKind === CHANGE_KIND.NONE) {
    throw new Error(
      "PR body must declare a real `Change-Kind:` (`added`, `fixed`, or `changed`) when " +
        "User-Facing is not `none`.",
    );
  }

  return {
    primaryPackage: packages[0],
    deliverySlices,
    packageSession: sessions[0].toLowerCase(),
    visualEvidence: evidence[0],
    userFacing: userFacing[0],
    changeKind,
  };
}

function buildImpactManifest({ baseSha, headSha, files, labels = [] }) {
  assertSha(baseSha, "baseSha");
  assertSha(headSha, "headSha");
  if (!Array.isArray(files)) throw new Error("Impact manifest requires a file list.");

  const uniqueFiles = [...new Set(files.map(normalizeRepoPath).filter(Boolean))].sort();
  const buckets = {
    frontend_product: [],
    frontend_test: [],
    frontend_infrastructure: [],
    backend: [],
    operations: [],
    documentation: [],
    other: [],
  };
  for (const file of uniqueFiles) buckets[classifyChangedFile(file)].push(file);

  const labelNames = labels.map((label) => typeof label === "string" ? label : label?.name)
    .filter(isNonEmptyString)
    .map((label) => label.toLowerCase());
  const frontendLabel = labelNames.includes("frontend");
  const frontendProduct = buckets.frontend_product.length > 0;
  const frontendTestOnly = !frontendProduct && buckets.frontend_test.length > 0 &&
    buckets.frontend_infrastructure.length === 0;
  const frontendTouched = frontendProduct || buckets.frontend_test.length > 0 ||
    buckets.frontend_infrastructure.length > 0;

  let visualEvidence;
  if (frontendProduct) {
    visualEvidence = { required: true, decision: "required", reason: "frontend-product-diff" };
  } else if (frontendTestOnly) {
    visualEvidence = { required: false, decision: "skip", reason: "test-only-frontend-diff" };
  } else {
    visualEvidence = { required: false, decision: "skip", reason: "no-visible-frontend-product-diff" };
  }

  return {
    schema: 1,
    source: "git-diff",
    range: `${baseSha}...${headSha}`,
    base_sha: baseSha,
    head_sha: headSha,
    labels: { frontend: frontendLabel },
    diff: { files: uniqueFiles, ...buckets },
    effective: {
      frontend: frontendTouched,
      frontend_product: frontendProduct,
      frontend_test_only: frontendTestOnly,
      backend: buckets.backend.length > 0,
      operations: buckets.operations.length > 0,
      documentation: buckets.documentation.length > 0,
      label_overridden_by_diff: frontendLabel !== frontendTouched,
    },
    visual_evidence: visualEvidence,
    browser_scope: frontendProduct ? "targeted-visible-flow" : "none",
  };
}

function buildImpactManifestFromGit({ baseSha, headSha, labels = [] }) {
  assertSha(baseSha, "baseSha");
  assertSha(headSha, "headSha");
  const raw = execFileSync(
    "git",
    ["diff", "--name-only", "-z", `${baseSha}...${headSha}`],
    { encoding: "utf8" },
  );
  return buildImpactManifest({ baseSha, headSha, files: raw.split("\0").filter(Boolean), labels });
}

function planReleaseQa(input) {
  assertSha(input?.lastQaSha, "lastQaSha");
  assertSha(input?.currentMainSha, "currentMainSha");
  if (!Number.isInteger(input.integrationsSinceQa) || input.integrationsSinceQa < 0) {
    throw new Error("Release QA planning requires a non-negative integrationsSinceQa count.");
  }
  if (!Array.isArray(input.impactManifests)) {
    throw new Error("Release QA planning requires impactManifests.");
  }
  input.impactManifests.forEach(validateImpactManifest);

  const reasons = [];
  if (input.packageComplete === true) reasons.push("package-complete");
  if (input.integrationsSinceQa >= 3) reasons.push("three-integrations");
  if (input.highRisk === true) reasons.push("high-risk");
  if (input.releaseTag === true) reasons.push("release-tag");

  const frontendProduct = input.impactManifests.some(
    (manifest) => manifest.effective.frontend_product,
  );
  return {
    schema: 1,
    required: reasons.length > 0,
    reasons,
    range: `${input.lastQaSha}..${input.currentMainSha}`,
    anchor: { from: input.lastQaSha, to: input.currentMainSha },
    integrations_since_qa: input.integrationsSinceQa,
    frontend_product: frontendProduct,
    visual_evidence: frontendProduct
      ? { required: true, reason: "release-range-has-frontend-product-diff" }
      : { required: false, reason: "release-range-has-no-frontend-product-diff" },
    delivery: "package-comment",
    create_qa_issues: false,
  };
}

function classifyChangedFile(file) {
  if (isDocumentationFile(file)) return "documentation";
  if (isFrontendTestFile(file)) return "frontend_test";
  if (isFrontendProductFile(file)) return "frontend_product";
  if (file.startsWith("frontend/")) return "frontend_infrastructure";
  if (file.startsWith("backend/")) return "backend";
  if (
    file.startsWith(".github/") ||
    file.startsWith("ops/") ||
    file.startsWith("scripts/") ||
    file.startsWith("make/") ||
    /(^|\/)(Dockerfile|docker-compose[^/]*\.ya?ml)$/.test(file) ||
    ["AGENTS.md", "CLAUDE.md", "Makefile"].includes(file)
  ) return "operations";
  return "other";
}

function isFrontendTestFile(file) {
  return file.startsWith("e2e/") ||
    (file.startsWith("frontend/") && (
      /(^|\/)__tests__\//.test(file) ||
      /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) ||
      /(^|\/)(?:test|tests|fixtures|mocks)\//.test(file)
    ));
}

function isFrontendProductFile(file) {
  return file.startsWith("frontend/src/") ||
    file.startsWith("frontend/public/") ||
    file === "frontend/index.html";
}

function isDocumentationFile(file) {
  return file.startsWith("docs/") || file === "README.md" || file === "OFFLINE_RESOLUTION_LOG.md";
}

function validateImpactManifest(manifest) {
  if (
    !manifest ||
    manifest.schema !== 1 ||
    manifest.source !== "git-diff" ||
    !manifest.diff ||
    !Array.isArray(manifest.diff.files) ||
    !manifest.effective ||
    !manifest.visual_evidence ||
    typeof manifest.effective.frontend_product !== "boolean" ||
    typeof manifest.effective.frontend_test_only !== "boolean" ||
    typeof manifest.visual_evidence.required !== "boolean"
  ) {
    throw new Error("Review admission requires a valid diff-generated impact manifest.");
  }
  assertSha(manifest.base_sha, "impact base_sha");
  assertSha(manifest.head_sha, "impact head_sha");
  return manifest;
}

function expectedVisualEvidenceValue(manifest) {
  if (manifest.visual_evidence.required) return VISUAL_EVIDENCE.PROVIDED;
  if (manifest.visual_evidence.reason === "test-only-frontend-diff") {
    return VISUAL_EVIDENCE.TEST_ONLY_SKIP;
  }
  return VISUAL_EVIDENCE.NON_VISIBLE_SKIP;
}

function parseDeliverySlices(value) {
  if (value === "none") return [];
  const slices = value.split(",").map((part) => normalizeIdentifier(part.trim()));
  if (slices.length === 0 || new Set(slices).size !== slices.length) {
    throw new Error("Delivery-Slices must be `none` or a unique comma-separated NIL list.");
  }
  return slices;
}

function fieldValues(text, name) {
  const pattern = new RegExp(`^${escapeRegExp(name)}:\\s*(.*?)\\s*$`, "gim");
  return [...text.matchAll(pattern)].map((match) => match[1]);
}

function readPackageOwner(metadata) {
  const agentId = metadata.package_owner_agent_id;
  const sessionId = metadata.package_owner_session_id;
  const worktree = metadata.package_worktree;
  const present = [agentId, sessionId, worktree].filter(isNonEmptyString).length;
  if (present === 0) return null;
  if (present !== 3 || !SESSION_PATTERN.test(sessionId) || !isAbsolutePath(worktree)) return null;
  return { agent_id: agentId, session_id: sessionId.toLowerCase(), worktree };
}

function packageOwnerFieldCount(metadata) {
  return [
    metadata.package_owner_agent_id,
    metadata.package_owner_session_id,
    metadata.package_worktree,
  ].filter(isNonEmptyString).length;
}

function isUnclaimedStatus(value) {
  return value === undefined || value === null || value === "unclaimed";
}

function acceptedRoute(identifier, deliveryModel, trigger, eventId, owner, code) {
  return {
    ok: true,
    dispatch: true,
    code,
    identifier,
    deliveryModel,
    trigger,
    owner,
    idempotencyKey: `${identifier}:${trigger}:${eventId}`,
    maxActiveSessions: MAX_ACTIVE_SESSIONS,
  };
}

function rejectedRoute(code, reason, identifier, deliveryModel, owner = null) {
  return { ok: false, dispatch: false, code, reason, identifier, deliveryModel, owner };
}

function normalizeIdentifier(value) {
  const identifier = String(value || "").toUpperCase();
  if (!IDENTIFIER_PATTERN.test(identifier)) throw new Error(`Invalid Multica identifier: ${String(value)}`);
  return identifier;
}

function normalizeRepoPath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function isAbsolutePath(value) {
  return typeof value === "string" && value.startsWith("/") && value.length > 1;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function assertSha(value, name) {
  if (!SHA_PATTERN.test(value || "")) throw new Error(`${name} must be a 40-character lowercase SHA.`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readStdin() {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

async function main() {
  const command = process.argv[2];
  if (command === "route" || command === "claim" || command === "release-qa") {
    const input = JSON.parse(await readStdin());
    const result = command === "route"
      ? routeExecutionUnit(input)
      : command === "claim"
        ? planPackageClaim(input)
        : planReleaseQa(input);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if ((command === "route" || command === "claim") && !result.dispatch) process.exitCode = 1;
    return;
  }
  if (command === "impact") {
    const labels = JSON.parse(process.env.PR_LABELS_JSON || "[]");
    const result = buildImpactManifestFromGit({
      baseSha: process.env.PR_BASE_SHA,
      headSha: process.env.PR_HEAD_SHA,
      labels,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "admission") {
    const result = checkPrAdmission({
      body: process.env.PR_BODY,
      draft: process.env.PR_DRAFT === "true",
      authorType: process.env.PR_AUTHOR_TYPE,
      impactManifest: JSON.parse(process.env.IMPACT_MANIFEST || "null"),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  throw new Error("Usage: delivery-v2.cjs route|claim|impact|admission|release-qa");
}

module.exports = {
  ACCEPTANCE_SLICE,
  CHANGE_KIND,
  MAX_ACTIVE_SESSIONS,
  OWNERSHIP_PACKAGE,
  READY_GATE_LINES,
  TICKET_REFERENCE_PATTERN,
  USER_FACING_NONE,
  VISUAL_EVIDENCE,
  buildImpactManifest,
  buildImpactManifestFromGit,
  checkPrAdmission,
  classifyChangedFile,
  fieldValues,
  parsePrDeliveryContract,
  planPackageClaim,
  planReleaseQa,
  routeExecutionUnit,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
