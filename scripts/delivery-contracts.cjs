#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const { parsePrDeliveryContract } = require("./delivery-v2.cjs");

const REVIEW_MARKER = /<!-- excalidash-review:v1\s*([\s\S]*?)\s*-->/m;
const FIX_VERIFICATION_MARKER = /<!-- excalidash-fix-verification:v1\s*([\s\S]*?)\s*-->/gm;
const FIX_VERIFICATION_MARKER_START = /<!-- excalidash-fix-verification:v1\b/;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const LOWER_SHA_PATTERN = /^[0-9a-f]{40}$/;
const REVIEW_RESULTS = new Set([
  "clean",
  "findings",
  "needs_answer",
  "inconclusive",
]);
const REQUIRED_GIT_IDENTITY = "Nilo <127136134+davifernan@users.noreply.github.com>";
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const FIX_EVIDENCE_TYPES = new Set(["objective-red-green", "finding-verification"]);
const FIX_VERIFIER_ROLES = new Set(["pr-overseer", "finding-verifier"]);

function parseReviewMarker(body) {
  const match = REVIEW_MARKER.exec(body || "");
  if (!match) {
    throw new Error("Hans review is missing the excalidash-review:v1 marker.");
  }

  let marker;
  try {
    marker = JSON.parse(match[1]);
  } catch (error) {
    throw new Error(`Hans review marker is not valid JSON: ${error.message}`);
  }

  const requiredCounts = ["high", "medium", "low", "questions"];
  if (
    marker.schema !== 1 ||
    marker.reviewer !== "hans-friedrich" ||
    !SHA_PATTERN.test(marker.reviewed_head_sha || "") ||
    !REVIEW_RESULTS.has(marker.result) ||
    !marker.counts ||
    requiredCounts.some(
      (key) => !Number.isInteger(marker.counts[key]) || marker.counts[key] < 0,
    ) ||
    !Number.isInteger(marker.inline_comments) ||
    marker.inline_comments < 0
  ) {
    throw new Error("Hans review marker does not satisfy schema version 1.");
  }

  const findingCount = marker.counts.high + marker.counts.medium + marker.counts.low;
  const totalCount = findingCount + marker.counts.questions;
  if (marker.result === "clean" && totalCount !== 0) {
    throw new Error("A clean Hans marker cannot contain findings or questions.");
  }
  if (marker.result === "findings" && findingCount === 0) {
    throw new Error("A findings Hans marker must contain at least one finding.");
  }
  if (marker.result === "needs_answer" && marker.counts.questions === 0) {
    throw new Error("A needs_answer Hans marker must contain a question.");
  }

  return marker;
}

function parseFixVerificationMarker(body) {
  const matches = [...(body || "").matchAll(FIX_VERIFICATION_MARKER)];
  if (matches.length === 0) {
    throw new Error(
      "Fix-verification comment is missing the excalidash-fix-verification:v1 marker.",
    );
  }
  if (matches.length !== 1) {
    throw new Error("A fix-verification comment must contain exactly one marker.");
  }

  let marker;
  try {
    marker = JSON.parse(matches[0][1]);
  } catch (error) {
    throw new Error(`Fix-verification marker is not valid JSON: ${error.message}`);
  }

  if (
    marker.schema !== 1 ||
    !LOWER_SHA_PATTERN.test(marker.from_sha || "") ||
    !LOWER_SHA_PATTERN.test(marker.to_sha || "") ||
    marker.from_sha === marker.to_sha ||
    !FIX_EVIDENCE_TYPES.has(marker.evidence_type) ||
    !isNonEmptyString(marker.finding?.id) ||
    !isHttpsUrl(marker.finding?.url) ||
    !FIX_VERIFIER_ROLES.has(marker.recorded_by?.role) ||
    !isNonEmptyString(marker.recorded_by?.actor) ||
    !isValidFixRecipe(marker.recipe)
  ) {
    throw new Error("Fix-verification marker does not satisfy schema version 1.");
  }

  return marker;
}

function checkFixVerificationCoverage({ fromSha, toSha, comments = [] }) {
  if (!LOWER_SHA_PATTERN.test(fromSha || "") || !LOWER_SHA_PATTERN.test(toSha || "")) {
    throw new Error("Fix-verification coverage requires valid from and to SHAs.");
  }
  if (fromSha === toSha) {
    throw new Error("Fix-verification coverage requires a non-empty SHA delta.");
  }
  if (!Array.isArray(comments)) {
    throw new Error("Fix-verification coverage requires a comment array.");
  }

  const validRecords = [];
  let invalidRecords = 0;
  for (const [index, comment] of comments.entries()) {
    if (!FIX_VERIFICATION_MARKER_START.test(comment?.body || "")) continue;
    try {
      const marker = parseFixVerificationMarker(comment?.body);
      if (
        !isNonEmptyString(comment?.user?.login) ||
        comment.user.login.toLowerCase() !== marker.recorded_by.actor.toLowerCase()
      ) {
        throw new Error("Fix-verification marker actor differs from its GitHub comment author.");
      }
      validRecords.push({ index, comment, marker });
    } catch {
      invalidRecords += 1;
    }
  }

  const matchingRecords = validRecords.filter(
    ({ marker }) => marker.from_sha === fromSha && marker.to_sha === toSha,
  );
  matchingRecords.sort(compareNewestCommentFirst);

  const match = matchingRecords[0];
  if (!match) {
    return {
      covered: false,
      code: "uncovered",
      fromSha,
      toSha,
      invalidRecords,
    };
  }

  return {
    covered: true,
    code: "covered",
    fromSha,
    toSha,
    invalidRecords,
    record: {
      commentId: match.comment.id,
      evidenceType: match.marker.evidence_type,
      finding: match.marker.finding,
      recordedBy: match.marker.recorded_by,
      recipe: match.marker.recipe,
    },
  };
}

function isValidFixRecipe(recipe) {
  if (
    !recipe ||
    !isNonEmptyString(recipe.command) ||
    !isCommandResult(recipe.from) ||
    !isCommandResult(recipe.to)
  ) {
    return false;
  }

  if (recipe.kind === "test") {
    return Boolean(
      isNonEmptyString(recipe.instrument?.path) &&
      LOWER_SHA_PATTERN.test(recipe.instrument?.blob_sha || "") &&
      recipe.from.exit_code !== 0 &&
      isNonEmptyString(recipe.from.assertion) &&
      recipe.from.output.includes(recipe.from.assertion) &&
      recipe.to.exit_code === 0,
    );
  }

  if (recipe.kind === "configuration") {
    return Boolean(
      isNonEmptyString(recipe.subject?.key) &&
      isNonEmptyString(recipe.subject?.from_value) &&
      isNonEmptyString(recipe.subject?.to_value) &&
      recipe.subject.from_value !== recipe.subject.to_value &&
      recipe.from.output !== recipe.to.output &&
      recipe.from.output.includes(recipe.subject.from_value) &&
      recipe.to.output.includes(recipe.subject.to_value),
    );
  }

  return false;
}

function isCommandResult(result) {
  return Boolean(
    result &&
    Number.isInteger(result.exit_code) &&
    result.exit_code >= 0 &&
    result.exit_code <= 255 &&
    isNonEmptyString(result.output),
  );
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isHttpsUrl(value) {
  if (!isNonEmptyString(value)) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function compareNewestCommentFirst(left, right) {
  const leftTime = Date.parse(left.comment.created_at || "") || 0;
  const rightTime = Date.parse(right.comment.created_at || "") || 0;
  if (rightTime !== leftTime) return rightTime - leftTime;

  try {
    const leftId = BigInt(left.comment.id);
    const rightId = BigInt(right.comment.id);
    if (leftId !== rightId) return leftId > rightId ? -1 : 1;
  } catch {
    // Keep deterministic API-order fallback for malformed fixture ids.
  }
  return right.index - left.index;
}

function validateHansReview({ expectedHeadSha, review, comments = [] }) {
  if (!SHA_PATTERN.test(expectedHeadSha || "")) {
    throw new Error("Expected PR head SHA is missing or invalid.");
  }

  const result = validateHansReviewRecord({ review, comments });
  if (expectedHeadSha !== result.reviewedHeadSha) {
    throw new Error("Hans reviewed a stale PR head SHA.");
  }

  return result;
}

function validateHansReviewRecord({ review, comments = [] }) {
  if (!review || review.state !== "COMMENTED") {
    throw new Error("Hans review must be a COMMENTED GitHub review.");
  }
  if (review.user?.login !== "the-hans-friedrich[bot]") {
    throw new Error("Review author is not the Hans-Friedrich GitHub App.");
  }

  const marker = parseReviewMarker(review.body);
  if (review.commit_id !== marker.reviewed_head_sha) {
    throw new Error("GitHub review commit and Hans marker SHA differ.");
  }

  const reviewComments = comments.filter(
    (comment) => comment.pull_request_review_id === review.id,
  );
  if (reviewComments.length !== marker.inline_comments) {
    throw new Error("Hans marker and GitHub inline comment count differ.");
  }

  const inlineCounts = countInlineMarkers(reviewComments);
  for (const key of Object.keys(inlineCounts)) {
    if (inlineCounts[key] > marker.counts[key]) {
      throw new Error(`Inline ${key} count exceeds the Hans marker total.`);
    }
  }

  return {
    ok: true,
    state: marker.result,
    reviewedHeadSha: marker.reviewed_head_sha,
    counts: marker.counts,
    inlineComments: marker.inline_comments,
  };
}

function checkReviewedHead({ pullRequest, reviews = [], comments = [] }) {
  const currentHeadSha = pullRequest?.head?.sha;
  if (!SHA_PATTERN.test(currentHeadSha || "")) {
    throw new Error("Current PR head SHA is missing or invalid.");
  }
  if (!Array.isArray(reviews) || !Array.isArray(comments)) {
    throw new Error("Reviewed-head check requires review and comment arrays.");
  }

  if (pullRequest.draft) {
    return {
      ok: true,
      code: "draft",
      currentHeadSha,
      reviewedHeadSha: null,
      message: "Draft PRs do not require a Hans review yet.",
    };
  }

  const validReviews = [];
  for (const [index, review] of reviews.entries()) {
    try {
      validReviews.push({
        index,
        review,
        result: validateHansReviewRecord({ review, comments }),
      });
    } catch {
      // Invalid reviews are not candidates. The check deliberately selects the
      // newest intrinsically valid Hans record, rather than trusting API order
      // or accepting a marker copied into PR-controlled content.
    }
  }

  validReviews.sort((left, right) => {
    const leftTime = Date.parse(left.review.submitted_at || "") || 0;
    const rightTime = Date.parse(right.review.submitted_at || "") || 0;
    if (rightTime !== leftTime) return rightTime - leftTime;

    try {
      const leftId = BigInt(left.review.id);
      const rightId = BigInt(right.review.id);
      if (leftId !== rightId) return leftId > rightId ? -1 : 1;
    } catch {
      // A real GitHub review has a numeric id. Keep deterministic API-order
      // fallback for malformed fixture data without making it a valid review.
    }
    return right.index - left.index;
  });

  const latest = validReviews[0];
  if (!latest) {
    throw new Error(
      "No valid Hans review with an excalidash-review:v1 marker exists for this PR.",
    );
  }

  if (currentHeadSha !== latest.result.reviewedHeadSha) {
    throw new Error(
      `Current PR head ${currentHeadSha} does not match latest valid Hans review ${latest.result.reviewedHeadSha}.`,
    );
  }

  return {
    ok: true,
    code: "current",
    currentHeadSha,
    reviewedHeadSha: latest.result.reviewedHeadSha,
    reviewId: latest.review.id,
    reviewResult: latest.result.state,
  };
}

function checkCommitContracts(commits) {
  if (!Array.isArray(commits) || commits.length === 0) {
    throw new Error("The pull request has no commits to admit.");
  }

  const violations = [];
  for (const commit of commits) {
    const shortSha = (commit.sha || "unknown").slice(0, 12);
    if (commit.author !== REQUIRED_GIT_IDENTITY) {
      violations.push(`${shortSha}: author is ${commit.author || "missing"}`);
    }
    if (commit.committer !== REQUIRED_GIT_IDENTITY) {
      violations.push(`${shortSha}: committer is ${commit.committer || "missing"}`);
    }
    if (!(commit.message || "").trimEnd().endsWith("Generated by Nilo")) {
      violations.push(`${shortSha}: commit message lacks the Generated by Nilo trailer`);
    }
  }

  if (violations.length > 0) {
    throw new Error(`Commit admission failed:\n${violations.join("\n")}`);
  }

  return { ok: true, commits: commits.length };
}

function admitCommitContracts({ baseContainsPolicy, commits }) {
  if (!baseContainsPolicy) {
    return {
      ok: true,
      bootstrap: true,
      commits: commits.length,
      message: "Commit identity policy is being installed by this pull request.",
    };
  }
  return { ...checkCommitContracts(commits), bootstrap: false };
}

function baseContainsCommitPolicy(baseSha) {
  try {
    execFileSync(
      "git",
      ["cat-file", "-e", `${baseSha}:scripts/delivery-contracts.cjs`],
      { stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}

function readCommitRange(baseSha, headSha) {
  if (!SHA_PATTERN.test(baseSha || "") || !SHA_PATTERN.test(headSha || "")) {
    throw new Error("Commit admission requires valid base and head SHAs.");
  }

  const shas = execFileSync("git", ["rev-list", "--reverse", `${baseSha}..${headSha}`], {
    encoding: "utf8",
  }).trim().split("\n").filter(Boolean);

  return shas.map((sha) => {
    const fields = execFileSync(
      "git",
      ["show", "-s", "--format=%an <%ae>%x00%cn <%ce>%x00%B", sha],
      { encoding: "utf8" },
    ).split("\0");
    return {
      sha,
      author: fields[0],
      committer: fields[1],
      message: fields.slice(2).join("\0"),
    };
  });
}

function countInlineMarkers(comments) {
  const counts = { high: 0, medium: 0, low: 0, questions: 0 };
  for (const comment of comments) {
    const body = comment.body || "";
    if (/^🔴 \*\*High\*\*/u.test(body)) counts.high += 1;
    else if (/^🟡 \*\*Medium\*\*/u.test(body)) counts.medium += 1;
    else if (/^🔵 \*\*Low\*\*/u.test(body)) counts.low += 1;
    else if (/^⚪ \*\*Frage\*\*/u.test(body)) counts.questions += 1;
  }
  return counts;
}

function buildDeliveryEvent({ eventName, payload, repository }) {
  let event;

  if (eventName === "pull_request") {
    const delivery = parseOptionalPrDeliveryContract(payload.pull_request?.body);
    event = {
      event: "pull_request",
      action: payload.action,
      repo: repository,
      pr: payload.pull_request?.number,
      head_sha: payload.pull_request?.head?.sha,
      base_sha: payload.pull_request?.base?.sha,
      draft: Boolean(payload.pull_request?.draft),
      merged: Boolean(payload.pull_request?.merged),
      merge_commit_sha: payload.pull_request?.merge_commit_sha || null,
      primary_package: delivery?.primaryPackage || null,
      delivery_slices: delivery?.deliverySlices || [],
      package_session: delivery?.packageSession || null,
      trusted_source:
        payload.pull_request?.head?.repo?.full_name === repository &&
        TRUSTED_ASSOCIATIONS.has(payload.pull_request?.author_association),
    };
  } else if (eventName === "pull_request_review") {
    const delivery = parseOptionalPrDeliveryContract(payload.pull_request?.body);
    event = {
      event: "pull_request_review",
      action: payload.action,
      repo: repository,
      pr: payload.pull_request?.number,
      head_sha: payload.pull_request?.head?.sha,
      reviewed_sha: payload.review?.commit_id,
      review_id: payload.review?.id,
      reviewer: payload.review?.user?.login,
      primary_package: delivery?.primaryPackage || null,
      delivery_slices: delivery?.deliverySlices || [],
      package_session: delivery?.packageSession || null,
      trusted_source:
        payload.review?.user?.login === "the-hans-friedrich[bot]" ||
        TRUSTED_ASSOCIATIONS.has(payload.review?.author_association),
    };
  } else if (eventName === "issue_comment" && payload.issue?.pull_request) {
    if (/Generated by PR Overseer/i.test(payload.comment?.body || "")) {
      return { skip: true, reason: "pr-overseer-self-comment" };
    }
    event = {
      event: "pull_request_comment",
      action: payload.action,
      repo: repository,
      pr: payload.issue.number,
      comment_id: payload.comment?.id,
      author: payload.comment?.user?.login,
      updated_at: payload.comment?.updated_at,
      trusted_source: TRUSTED_ASSOCIATIONS.has(payload.comment?.author_association),
    };
  } else if (eventName === "workflow_run") {
    const pullRequest = payload.workflow_run?.pull_requests?.[0];
    if (!pullRequest) return { skip: true, reason: "workflow-run-without-pr" };
    event = {
      event: "workflow_run",
      action: payload.action,
      repo: repository,
      pr: pullRequest.number,
      head_sha: payload.workflow_run?.head_sha,
      workflow: payload.workflow_run?.name,
      conclusion: payload.workflow_run?.conclusion,
      workflow_run_id: payload.workflow_run?.id,
      trusted_source: true,
    };
  } else {
    return { skip: true, reason: `unsupported-${eventName}` };
  }

  if (!Number.isInteger(event.pr)) {
    return { skip: true, reason: "event-without-pr" };
  }
  if (!event.trusted_source) {
    return { skip: true, reason: "untrusted-source" };
  }

  if (eventName === "pull_request") {
    const mergeState = event.action === "closed" ? `:merged=${event.merged}` : "";
    event.delivery_event_id =
      `${eventName}:${event.pr}:${event.action}:${event.head_sha}${mergeState}`;
  } else if (eventName === "pull_request_review") {
    event.delivery_event_id = `${eventName}:${event.review_id}`;
  } else if (eventName === "issue_comment") {
    event.delivery_event_id = `${eventName}:${event.comment_id}:${event.action}:${event.updated_at}`;
  } else {
    event.delivery_event_id = `${eventName}:${event.workflow_run_id}`;
  }
  return {
    skip: false,
    event,
    idempotencyKey: `${repository}#${event.pr}:${event.delivery_event_id}`,
  };
}

function parseOptionalPrDeliveryContract(body) {
  const text = body || "";
  const hasDeliveryField = /^(?:Multica-Package|Delivery-Slices|Package-Session|Impact-Manifest|Visual-Evidence):/im
    .test(text);
  return hasDeliveryField ? parsePrDeliveryContract(text) : null;
}

async function main() {
  const command = process.argv[2];
  if (command === "review") {
    const input = JSON.parse(await readStdin());
    process.stdout.write(`${JSON.stringify(validateHansReview(input))}\n`);
    return;
  }

  if (command === "reviewed-head") {
    const input = JSON.parse(await readStdin());
    process.stdout.write(`${JSON.stringify(checkReviewedHead(input))}\n`);
    return;
  }

  if (command === "fix-verification") {
    const input = JSON.parse(await readStdin());
    process.stdout.write(`${JSON.stringify(checkFixVerificationCoverage(input))}\n`);
    return;
  }

  if (command === "commits") {
    const commits = readCommitRange(process.env.PR_BASE_SHA, process.env.PR_HEAD_SHA);
    const result = admitCommitContracts({
      baseContainsPolicy: baseContainsCommitPolicy(process.env.PR_BASE_SHA),
      commits,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  if (command === "event") {
    const payload = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    const result = buildDeliveryEvent({
      eventName: process.env.GITHUB_EVENT_NAME,
      payload,
      repository: process.env.GITHUB_REPOSITORY,
      runId: process.env.GITHUB_RUN_ID,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  throw new Error(
    "Usage: delivery-contracts.cjs commits|review|reviewed-head|fix-verification|event",
  );
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
    });
    process.stdin.on("end", () => resolve(input));
    process.stdin.on("error", reject);
  });
}

module.exports = {
  buildDeliveryEvent,
  admitCommitContracts,
  checkCommitContracts,
  checkFixVerificationCoverage,
  parseReviewMarker,
  parseFixVerificationMarker,
  checkReviewedHead,
  validateHansReview,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
