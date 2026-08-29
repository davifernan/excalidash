"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  TRACKING_LABEL,
  ISSUE_LIST_LIMIT,
  findTrackingIssue,
  createTrackingIssue,
  resolveTrackingIssueNumber,
  buildCommentBody,
} = require("./soak-nightly-notify.cjs");

/**
 * NIL-639 Hans finding/question on #223: was the old `gh issue list
 * --search "<title>" in:title` lookup missing the tracking issue because of
 * its punctuation? Measured live: no -- GitHub's issue search tokenizes and
 * is NOT a phrase match, so a completely different word order still found
 * the same issue by title. The real risk ran the other way: no explicit
 * --limit (gh defaults to 30) meant the real tracking issue could fall off
 * the result page once >30 open issues shared a token with its title, and
 * --state open meant closing it produced a duplicate on the next run. This
 * file's tests cover the label-based replacement chosen instead of fixing
 * the search: gh issue list --label is an exact match, not tokenized, and
 * cannot silently drop the real issue the way a search page limit can.
 */

test("findTrackingIssue calls gh issue list with an explicit --label, --state all, and an explicit --limit", () => {
  let capturedArgs = null;
  const gh = (args) => {
    capturedArgs = args;
    return JSON.stringify([
      { number: 42, title: "Nightly Team-Readiness Soak -- status", state: "OPEN" },
    ]);
  };
  const issueNumber = findTrackingIssue(gh);
  assert.equal(issueNumber, 42);
  assert.ok(capturedArgs.includes("--label"));
  assert.equal(capturedArgs[capturedArgs.indexOf("--label") + 1], TRACKING_LABEL);
  assert.ok(capturedArgs.includes("--state"));
  assert.equal(capturedArgs[capturedArgs.indexOf("--state") + 1], "all");
  assert.ok(capturedArgs.includes("--limit"));
  assert.equal(capturedArgs[capturedArgs.indexOf("--limit") + 1], String(ISSUE_LIST_LIMIT));
  // The historical bug: a token search that could over-match or under-match
  // depending on other open issues' titles. The fixed call must not use
  // --search at all.
  assert.ok(!capturedArgs.includes("--search"));
});

test("findTrackingIssue finds a CLOSED tracking issue too, not just open ones", () => {
  const gh = () => JSON.stringify([{ number: 7, title: "x", state: "CLOSED" }]);
  assert.equal(findTrackingIssue(gh), 7);
});

test("findTrackingIssue returns null when no issue carries the label", () => {
  const gh = () => JSON.stringify([]);
  assert.equal(findTrackingIssue(gh), null);
});

test("createTrackingIssue ensures the label exists before creating, and applies it to the new issue", () => {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args[0] === "label") return "";
    if (args[0] === "issue" && args[1] === "create") {
      return "https://github.com/example/repo/issues/99\n";
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  const issueNumber = createTrackingIssue(gh);
  assert.equal(issueNumber, "99");

  const labelCall = calls.find((c) => c[0] === "label");
  assert.ok(labelCall, "expected a `gh label create` call before issue creation");
  assert.ok(labelCall.includes(TRACKING_LABEL));
  assert.ok(labelCall.includes("--force"), "label create must be idempotent across nightly runs");

  const createCall = calls.find((c) => c[0] === "issue" && c[1] === "create");
  assert.ok(createCall.includes("--label"));
  assert.equal(createCall[createCall.indexOf("--label") + 1], TRACKING_LABEL);
});

test("createTrackingIssue still creates the issue even if ensuring the label throws", () => {
  const gh = (args) => {
    if (args[0] === "label") throw new Error("permission denied");
    if (args[0] === "issue" && args[1] === "create") {
      return "https://github.com/example/repo/issues/5\n";
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  assert.equal(createTrackingIssue(gh), "5");
});

test("resolveTrackingIssueNumber uses the found issue and never creates a duplicate", () => {
  let createCalled = false;
  const gh = (args) => {
    if (args[0] === "issue" && args[1] === "list") {
      return JSON.stringify([{ number: 3, title: "x", state: "OPEN" }]);
    }
    createCalled = true;
    throw new Error("should not be called");
  };
  assert.equal(resolveTrackingIssueNumber(gh), 3);
  assert.equal(createCalled, false);
});

test("resolveTrackingIssueNumber creates a tracking issue only when none is found", () => {
  const gh = (args) => {
    if (args[0] === "issue" && args[1] === "list") return JSON.stringify([]);
    if (args[0] === "label") return "";
    if (args[0] === "issue" && args[1] === "create") {
      return "https://github.com/example/repo/issues/11\n";
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  assert.equal(resolveTrackingIssueNumber(gh), "11");
});

test("buildCommentBody uses a green emoji and PASSED for a passing run", () => {
  const body = buildCommentBody("passed", "summary text", "https://example.invalid/run/1");
  assert.match(body, /^🟢 \*\*PASSED\*\*/);
  assert.match(body, /summary text/);
  assert.match(body, /https:\/\/example\.invalid\/run\/1/);
});

test("buildCommentBody uses a red emoji and FAILED for a failing run", () => {
  const body = buildCommentBody("failed", "summary text", "https://example.invalid/run/1");
  assert.match(body, /^🔴 \*\*FAILED\*\*/);
});
