#!/usr/bin/env node
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { parseResultLine, buildSummary } = require("./soak-nightly-extract.cjs");

test("parseResultLine finds the last NIL330_SOAK_RESULT= line in a noisy log", () => {
  const log = [
    "some webserver noise",
    'NIL330_SOAK_RESULT={"drawingId":"stale","totalCycles":1}',
    "more noise in between",
    'NIL330_SOAK_RESULT={"drawingId":"abc-123","totalCycles":42,"perActorCycles":[{"cycles":20,"errors":[]},{"cycles":22,"errors":["boom"]}],"watchdogViolations":[],"actualElapsedMs":9000}',
  ].join("\n");
  const parsed = parseResultLine(log);
  assert.equal(parsed.drawingId, "abc-123");
  assert.equal(parsed.totalCycles, 42);
});

test("parseResultLine returns null when the log never printed a result", () => {
  assert.equal(parseResultLine("backend started\nfrontend ready\n"), null);
});

test("parseResultLine returns null on a truncated/corrupt result line rather than throwing", () => {
  assert.equal(parseResultLine('NIL330_SOAK_RESULT={"drawingId":"abc"'), null);
});

test("buildSummary sums cycles and errors across actors and carries the board id", () => {
  const resultJson = {
    drawingId: "board-1",
    actualElapsedMs: 12345,
    watchdogViolations: [{ actorId: 2 }],
    perActorCycles: [
      { cycles: 10, errors: [] },
      { cycles: 12, errors: ["timeout"] },
      { cycles: 9, errors: ["timeout", "timeout"] },
    ],
  };
  const summary = buildSummary(1, 0, resultJson);
  assert.equal(summary.passed, true);
  assert.equal(summary.boardId, "board-1");
  assert.equal(summary.cycles, 31);
  assert.equal(summary.errorCount, 3);
  assert.equal(summary.watchdogViolations, 1);
  assert.equal(summary.actualElapsedMs, 12345);
});

test("buildSummary marks a nonzero exit code as not passed even with a result present", () => {
  const summary = buildSummary(2, 1, {
    drawingId: "board-2",
    perActorCycles: [],
    watchdogViolations: [],
  });
  assert.equal(summary.passed, false);
  assert.equal(summary.boardId, "board-2");
});

test("buildSummary handles a missing result (crash before printing) without throwing", () => {
  const summary = buildSummary(3, 1, null);
  assert.equal(summary.passed, false);
  assert.equal(summary.boardId, "");
  assert.equal(summary.cycles, null);
});
