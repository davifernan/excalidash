"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildDeliveryEvent,
  admitCommitContracts,
  checkCommitContracts,
  checkFixVerificationCoverage,
  checkPrAdmission,
  checkReviewedHead,
  parseFixVerificationMarker,
  validateHansReview,
} = require("./delivery-contracts.cjs");

const SHA = "a".repeat(40);
const FIX_SHA = "b".repeat(40);
const NEXT_SHA = "c".repeat(40);
const TEST_BLOB_SHA = "d".repeat(40);
const NILO_IDENTITY = "Nilo <127136134+davifernan@users.noreply.github.com>";

function readyBody(extra = "") {
  return `Multica-Issue: NIL-385

- [x] Multica HANDOFF posted
- [x] Local verification complete
- [x] Ready for Hans-Friedrich
${extra}`;
}

function reviewedReadyBody() {
  return `Multica-Issue: NIL-316

- [x] Multica HANDOFF posted for the reviewed product head and the re-admitted test-only head.
- [x] Local verification complete for finding-fix head \`85f5554\`.
- [x] Hans-Friedrich completed the one general review on \`33c8112\`.
`;
}

function marker(overrides = {}) {
  const value = {
    schema: 1,
    reviewer: "hans-friedrich",
    reviewed_head_sha: SHA,
    result: "clean",
    counts: { high: 0, medium: 0, low: 0, questions: 0 },
    inline_comments: 0,
    ...overrides,
  };
  return `<!-- excalidash-review:v1\n${JSON.stringify(value)}\n-->`;
}

function review(body = marker()) {
  return {
    id: 42,
    state: "COMMENTED",
    commit_id: SHA,
    user: { login: "the-hans-friedrich[bot]" },
    body,
    submitted_at: "2026-08-22T17:00:00Z",
  };
}

function fixVerificationMarker(overrides = {}) {
  const value = {
    schema: 1,
    from_sha: SHA,
    to_sha: FIX_SHA,
    evidence_type: "objective-red-green",
    finding: {
      id: "PR-12-R123",
      url: "https://github.com/davifernan/excalidash/pull/12#discussion_r123",
    },
    recorded_by: { role: "pr-overseer", actor: "davi" },
    recipe: {
      kind: "test",
      command: "node --test scripts/delivery-contracts.test.cjs",
      instrument: {
        path: "scripts/delivery-contracts.test.cjs",
        blob_sha: TEST_BLOB_SHA,
      },
      from: {
        exit_code: 1,
        assertion: "the exact recorded SHA delta must be covered",
        output: "AssertionError: the exact recorded SHA delta must be covered; false !== true",
      },
      to: { exit_code: 0, output: "tests 1; pass 1; fail 0" },
    },
    ...overrides,
  };
  return `<!-- excalidash-fix-verification:v1\n${JSON.stringify(value)}\n-->`;
}

function fixVerificationComment(overrides = {}) {
  return {
    id: 99,
    user: { login: "davi" },
    created_at: "2026-08-22T20:00:00Z",
    body: fixVerificationMarker(overrides),
  };
}

test("admits exactly one ready Multica PR", () => {
  assert.deepEqual(checkPrAdmission({ body: readyBody() }), {
    ok: true,
    code: "ready",
    primaryIssue: "NIL-385",
  });
});

test("admits the explanatory ready-gate labels from PR #13", () => {
  assert.deepEqual(checkPrAdmission({ body: reviewedReadyBody() }), {
    ok: true,
    code: "ready",
    primaryIssue: "NIL-316",
  });

  const readinessDetails = readyBody()
    .replace("Multica HANDOFF posted", "Multica HANDOFF posted for head abc123")
    .replace("Local verification complete", "Local verification complete for head abc123")
    .replace("Ready for Hans-Friedrich", "Ready for Hans-Friedrich on head abc123");
  assert.equal(checkPrAdmission({ body: readinessDetails }).code, "ready");
});

test("still rejects an unchecked box or a missing ready-gate label", () => {
  const unchecked = reviewedReadyBody().replace(
    "- [x] Multica HANDOFF posted",
    "- [ ] Multica HANDOFF posted",
  );
  assert.deepEqual(checkPrAdmission({ body: unchecked }), {
    ok: false,
    code: "ready-gate",
    message: "Review admission is missing: Multica HANDOFF posted.",
  });

  const missingLabel = reviewedReadyBody().replace(
    "- [x] Local verification complete for finding-fix head `85f5554`.",
    "- [x] Finding-fix head `85f5554` was verified locally.",
  );
  assert.deepEqual(checkPrAdmission({ body: missingLabel }), {
    ok: false,
    code: "ready-gate",
    message: "Review admission is missing: Local verification complete.",
  });
});

test("rejects an incomplete or ambiguous PR before spending review tokens", () => {
  assert.equal(checkPrAdmission({ body: readyBody(), draft: true }).code, "draft");
  assert.equal(
    checkPrAdmission({ body: readyBody("\nMultica-Issue: NIL-328") }).code,
    "primary-issue",
  );
  assert.equal(
    checkPrAdmission({ body: "Multica-Issue: NIL-385" }).code,
    "ready-gate",
  );
  assert.equal(
    checkPrAdmission({ body: readyBody().replace("NIL-385", "NIL-000") }).code,
    "primary-issue",
  );
});

test("admits only exact Nilo-authored commits with the required trailer", () => {
  assert.deepEqual(
    checkCommitContracts([
      {
        sha: SHA,
        author: NILO_IDENTITY,
        committer: NILO_IDENTITY,
        message: "ci: add delivery contracts\n\nGenerated by Nilo\n",
      },
    ]),
    { ok: true, commits: 1 },
  );

  assert.throws(
    () => checkCommitContracts([
      {
        sha: FIX_SHA,
        author: "Codex <bot@example.com>",
        committer: NILO_IDENTITY,
        message: "ci: wrong author",
      },
    ]),
    /author is Codex.*lacks the Generated by Nilo trailer/s,
  );
});

test("the first policy installation bootstraps without a permanent identity exception", () => {
  const historicalCommit = {
    sha: SHA,
    author: "Nilo <me@nilo.live>",
    committer: "Nilo <me@nilo.live>",
    message: "docs: historical setup\n\nGenerated by Nilo",
  };
  assert.deepEqual(admitCommitContracts({
    baseContainsPolicy: false,
    commits: [historicalCommit],
  }), {
    ok: true,
    bootstrap: true,
    commits: 1,
    message: "Commit identity policy is being installed by this pull request.",
  });
  assert.throws(
    () => admitCommitContracts({ baseContainsPolicy: true, commits: [historicalCommit] }),
    /author is Nilo <me@nilo.live>/,
  );
});

test("validates a clean Hans review for the expected head", () => {
  assert.deepEqual(
    validateHansReview({ expectedHeadSha: SHA, review: review(), comments: [] }),
    {
      ok: true,
      state: "clean",
      reviewedHeadSha: SHA,
      counts: { high: 0, medium: 0, low: 0, questions: 0 },
      inlineComments: 0,
    },
  );
});

test("validates structured findings without re-reading review prose", () => {
  const body = marker({
    result: "findings",
    counts: { high: 1, medium: 0, low: 0, questions: 0 },
    inline_comments: 1,
  });
  const result = validateHansReview({
    expectedHeadSha: SHA,
    review: review(body),
    comments: [
      {
        pull_request_review_id: 42,
        body: "🔴 **High** · writes are silently discarded",
      },
    ],
  });
  assert.equal(result.state, "findings");
  assert.equal(result.counts.high, 1);
});

test("rejects a stale Hans review", () => {
  assert.throws(
    () => validateHansReview({ expectedHeadSha: FIX_SHA, review: review(), comments: [] }),
    /stale PR head SHA/,
  );
});

test("rejects missing markers and mismatched inline counts", () => {
  assert.throws(
    () =>
      validateHansReview({
        expectedHeadSha: SHA,
        review: review("Keine Befunde."),
        comments: [],
      }),
    /missing the excalidash-review:v1 marker/,
  );

  const body = marker({
    result: "findings",
    counts: { high: 1, medium: 0, low: 0, questions: 0 },
    inline_comments: 1,
  });
  assert.throws(
    () => validateHansReview({ expectedHeadSha: SHA, review: review(body), comments: [] }),
    /inline comment count differ/,
  );
});

test("reviewed-head check explicitly passes drafts without requiring a review", () => {
  assert.deepEqual(
    checkReviewedHead({
      pullRequest: { draft: true, head: { sha: FIX_SHA } },
      reviews: [],
      comments: [],
    }),
    {
      ok: true,
      code: "draft",
      currentHeadSha: FIX_SHA,
      reviewedHeadSha: null,
      message: "Draft PRs do not require a Hans review yet.",
    },
  );
});

test("reviewed-head check is red when no valid Hans review exists", () => {
  assert.throws(
    () =>
      checkReviewedHead({
        pullRequest: { draft: false, head: { sha: SHA } },
        reviews: [
          {
            ...review(marker()),
            user: { login: "someone-else" },
          },
          review("Looks good, but has no machine marker."),
        ],
        comments: [],
      }),
    /No valid Hans review with an excalidash-review:v1 marker exists for this PR/,
  );
});

test("reviewed-head check is red with a stale-SHA assertion", () => {
  assert.throws(
    () =>
      checkReviewedHead({
        pullRequest: { draft: false, head: { sha: FIX_SHA } },
        reviews: [review()],
        comments: [],
      }),
    new RegExp(`Current PR head ${FIX_SHA} does not match latest valid Hans review ${SHA}`),
  );
});

test("reviewed-head check is green when current and reviewed SHAs match", () => {
  assert.deepEqual(
    checkReviewedHead({
      pullRequest: { draft: false, head: { sha: SHA } },
      reviews: [review()],
      comments: [],
    }),
    {
      ok: true,
      code: "current",
      currentHeadSha: SHA,
      reviewedHeadSha: SHA,
      reviewId: 42,
      reviewResult: "clean",
    },
  );
});

test("reviewed-head check selects the newest valid Hans review", () => {
  const newest = {
    ...review(marker({ reviewed_head_sha: FIX_SHA })),
    id: 84,
    commit_id: FIX_SHA,
    submitted_at: "2026-08-22T17:00:00Z",
  };
  const invalidNewest = {
    ...review("<!-- excalidash-review:v1 not-json -->"),
    id: 126,
    submitted_at: "2026-08-22T19:00:00Z",
  };

  const result = checkReviewedHead({
    pullRequest: { draft: false, head: { sha: FIX_SHA } },
    reviews: [invalidNewest, review(), newest],
    comments: [],
  });

  assert.equal(result.reviewId, 84);
  assert.equal(result.reviewedHeadSha, FIX_SHA);
});

test("reviewed-head check rejects a marker that disagrees with its review record", () => {
  assert.throws(
    () =>
      checkReviewedHead({
        pullRequest: { draft: false, head: { sha: FIX_SHA } },
        reviews: [
          {
            ...review(marker({ reviewed_head_sha: FIX_SHA })),
            commit_id: SHA,
          },
        ],
        comments: [],
      }),
    /No valid Hans review with an excalidash-review:v1 marker exists for this PR/,
  );
});

test("an exact recorded fix delta is machine-readably covered", () => {
  const result = checkFixVerificationCoverage({
    fromSha: SHA,
    toSha: FIX_SHA,
    comments: [fixVerificationComment()],
  });

  assert.equal(result.covered, true, "the exact recorded SHA delta must be covered");
  assert.equal(result.record.evidenceType, "objective-red-green");
  assert.equal(result.record.finding.id, "PR-12-R123");
  assert.equal(result.record.recordedBy.actor, "davi");
});

test("a missing record and a push beyond the recorded fix are uncovered", () => {
  assert.deepEqual(
    checkFixVerificationCoverage({ fromSha: SHA, toSha: FIX_SHA, comments: [] }),
    {
      covered: false,
      code: "uncovered",
      fromSha: SHA,
      toSha: FIX_SHA,
      invalidRecords: 0,
    },
  );

  const pushedResult = checkFixVerificationCoverage({
    fromSha: SHA,
    toSha: NEXT_SHA,
    comments: [fixVerificationComment()],
  });
  assert.equal(pushedResult?.covered, false);
  assert.equal(pushedResult?.code, "uncovered");
});

test("fix-verification test recipes bind the instrument and both observations", () => {
  const parsed = parseFixVerificationMarker(fixVerificationMarker());
  assert.equal(parsed?.recipe.instrument.blob_sha, TEST_BLOB_SHA);
  assert.equal(parsed?.recipe.from.exit_code, 1);
  assert.match(parsed?.recipe.from.output, /AssertionError/);
  assert.equal(parsed?.recipe.to.exit_code, 0);

  const withoutInstrumentHash = JSON.parse(
    /<!-- excalidash-fix-verification:v1\s*([\s\S]*?)\s*-->/m.exec(
      fixVerificationMarker(),
    )[1],
  );
  delete withoutInstrumentHash.recipe.instrument.blob_sha;
  assert.throws(
    () => parseFixVerificationMarker(
      `<!-- excalidash-fix-verification:v1\n${JSON.stringify(withoutInstrumentHash)}\n-->`,
    ),
    /does not satisfy schema version 1/,
  );
});

test("configuration recipes describe the varied key without inventing a test file", () => {
  const recipe = {
    kind: "configuration",
    command: "docker compose -f docker-compose.prod.yml config",
    subject: {
      key: "services.backend.image",
      from_value: "zimengxiong/excalidash-backend:latest",
      to_value: "zimengxiong/excalidash-backend:0.4.18",
    },
    from: { exit_code: 0, output: "image: zimengxiong/excalidash-backend:latest" },
    to: { exit_code: 0, output: "image: zimengxiong/excalidash-backend:0.4.18" },
  };
  const parsed = parseFixVerificationMarker(
    fixVerificationMarker({ recipe }),
  );
  assert.equal(parsed?.recipe.kind, "configuration");
  assert.equal(parsed?.recipe.subject.key, "services.backend.image");
});

test("a finding verifier can record the same reproducible schema", () => {
  const parsed = parseFixVerificationMarker(
    fixVerificationMarker({
      evidence_type: "finding-verification",
      recorded_by: { role: "finding-verifier", actor: "finding-verifier[bot]" },
    }),
  );

  assert.equal(parsed.evidence_type, "finding-verification");
  assert.equal(parsed.recorded_by.role, "finding-verifier");
});

test("coverage ignores malformed or falsely attributed records", () => {
  const malformed = fixVerificationComment({
    recipe: {
      kind: "test",
      command: "node --test test.cjs",
      instrument: { path: "test.cjs" },
      from: {
        exit_code: 1,
        assertion: "expected old behavior",
        output: "AssertionError: expected old behavior",
      },
      to: { exit_code: 0, output: "pass" },
    },
  });
  const falseAttribution = {
    ...fixVerificationComment(),
    id: 100,
    user: { login: "someone-else" },
  };
  const ordinaryComment = { id: 101, user: { login: "davi" }, body: "Looks good." };

  assert.deepEqual(
    checkFixVerificationCoverage({
      fromSha: SHA,
      toSha: FIX_SHA,
      comments: [ordinaryComment, malformed, falseAttribution],
    }),
    {
      covered: false,
      code: "uncovered",
      fromSha: SHA,
      toSha: FIX_SHA,
      invalidRecords: 2,
    },
  );
});

test("normalizes PR and review events for the external overseer", () => {
  const pullRequest = buildDeliveryEvent({
    eventName: "pull_request",
    repository: "davifernan/excalidash",
    payload: {
      action: "synchronize",
      pull_request: {
        number: 7,
        head: { sha: FIX_SHA, repo: { full_name: "davifernan/excalidash" } },
        author_association: "OWNER",
        draft: false,
      },
    },
  });
  assert.equal(pullRequest.skip, false);
  assert.equal(pullRequest.event.head_sha, FIX_SHA);
  assert.match(pullRequest.idempotencyKey, /davifernan\/excalidash#7/);

  const reviewEvent = buildDeliveryEvent({
    eventName: "pull_request_review",
    repository: "davifernan/excalidash",
    payload: {
      action: "submitted",
      pull_request: { number: 7, head: { sha: FIX_SHA } },
      review: { id: 42, commit_id: SHA, user: { login: "the-hans-friedrich[bot]" } },
    },
  });
  assert.equal(reviewEvent.event.reviewed_sha, SHA);
  assert.equal(reviewEvent.event.head_sha, FIX_SHA);
});

test("delivery event identity survives workflow retries and ignores overseer comments", () => {
  const input = {
    eventName: "pull_request",
    repository: "davifernan/excalidash",
    payload: {
      action: "synchronize",
      pull_request: {
        number: 7,
        head: { sha: FIX_SHA, repo: { full_name: "davifernan/excalidash" } },
        author_association: "OWNER",
        draft: false,
      },
    },
  };
  assert.equal(
    buildDeliveryEvent({ ...input, runId: "first" }).idempotencyKey,
    buildDeliveryEvent({ ...input, runId: "retry" }).idempotencyKey,
  );

  assert.deepEqual(
    buildDeliveryEvent({
      eventName: "issue_comment",
      repository: "davifernan/excalidash",
      payload: {
        action: "created",
        issue: { number: 7, pull_request: {} },
        comment: { id: 9, body: "Generated by PR Overseer" },
      },
    }),
    { skip: true, reason: "pr-overseer-self-comment" },
  );
});

test("closed PR identity distinguishes merge state without weakening deduplication", () => {
  function closedEvent(merged) {
    return buildDeliveryEvent({
      eventName: "pull_request",
      repository: "davifernan/excalidash",
      payload: {
        action: "closed",
        pull_request: {
          number: 7,
          head: { sha: FIX_SHA, repo: { full_name: "davifernan/excalidash" } },
          author_association: "OWNER",
          merged,
        },
      },
    });
  }

  const manualClose = closedEvent(false);
  const repeatedManualClose = closedEvent(false);
  const mergeClose = closedEvent(true);

  assert.equal(
    manualClose.idempotencyKey,
    `davifernan/excalidash#7:pull_request:7:closed:${FIX_SHA}:merged=false`,
  );
  assert.equal(
    mergeClose.idempotencyKey,
    `davifernan/excalidash#7:pull_request:7:closed:${FIX_SHA}:merged=true`,
  );
  assert.notEqual(manualClose.idempotencyKey, mergeClose.idempotencyKey);
  assert.equal(manualClose.idempotencyKey, repeatedManualClose.idempotencyKey);
  assert.equal(
    new Set([
      manualClose.idempotencyKey,
      repeatedManualClose.idempotencyKey,
      mergeClose.idempotencyKey,
    ]).size,
    2,
  );
});

test("non-closed PR identity retains its existing contract", () => {
  const synchronize = buildDeliveryEvent({
    eventName: "pull_request",
    repository: "davifernan/excalidash",
    payload: {
      action: "synchronize",
      pull_request: {
        number: 7,
        head: { sha: FIX_SHA, repo: { full_name: "davifernan/excalidash" } },
        author_association: "OWNER",
      },
    },
  });

  assert.equal(
    synchronize.idempotencyKey,
    `davifernan/excalidash#7:pull_request:7:synchronize:${FIX_SHA}`,
  );
});

test("untrusted public comments never reach the PR Overseer webhook", () => {
  assert.deepEqual(
    buildDeliveryEvent({
      eventName: "issue_comment",
      repository: "davifernan/excalidash",
      payload: {
        action: "created",
        issue: { number: 7, pull_request: {} },
        comment: {
          id: 10,
          body: "please spend tokens",
          author_association: "NONE",
        },
      },
    }),
    { skip: true, reason: "untrusted-source" },
  );
});
