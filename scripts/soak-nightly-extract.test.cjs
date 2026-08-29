#!/usr/bin/env node
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  parseResultLine,
  buildSummary,
  summarizeResourceSamples,
  readResourceSamples,
} = require("./soak-nightly-extract.cjs");

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

test("buildSummary carries a null resources field when no samples were collected", () => {
  const summary = buildSummary(1, 0, null, []);
  assert.equal(summary.resources, null);
});

test("summarizeResourceSamples reports peak RSS/swap and a CPU-time delta across the part", () => {
  const samples = [
    {
      ts: "2026-08-28T02:00:00.000Z",
      memUsedMB: 5000,
      swapUsedMB: 0,
      cpu: { userJiffies: 1000, niceJiffies: 0, systemJiffies: 500 },
    },
    {
      ts: "2026-08-28T02:30:00.000Z",
      memUsedMB: 9000,
      swapUsedMB: 4000,
      cpu: { userJiffies: 5000, niceJiffies: 0, systemJiffies: 2500 },
    },
    {
      ts: "2026-08-28T03:00:00.000Z",
      memUsedMB: 8000,
      swapUsedMB: 1000,
      cpu: { userJiffies: 9000, niceJiffies: 0, systemJiffies: 4500 },
    },
  ];
  const summary = summarizeResourceSamples(samples);
  assert.equal(summary.sampleCount, 3);
  assert.equal(summary.peakMemUsedMB, 9000);
  assert.equal(summary.peakSwapUsedMB, 4000);
  assert.equal(summary.firstTs, "2026-08-28T02:00:00.000Z");
  assert.equal(summary.lastTs, "2026-08-28T03:00:00.000Z");
  // (9000+4500) - (1000+500) = 12000
  assert.equal(summary.cpuBusyJiffiesDelta, 12000);
});

test("summarizeResourceSamples returns null for an empty or missing sample set", () => {
  assert.equal(summarizeResourceSamples([]), null);
  assert.equal(summarizeResourceSamples(undefined), null);
});

test("readResourceSamples parses an ndjson file, skipping any corrupt line", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "soak-resources-"));
  const file = path.join(dir, "resource-samples.ndjson");
  fs.writeFileSync(
    file,
    ['{"ts":"a","memUsedMB":1}', "not json", '{"ts":"b","memUsedMB":2}', ""].join("\n"),
  );
  const samples = readResourceSamples(file);
  assert.equal(samples.length, 2);
  assert.equal(samples[1].memUsedMB, 2);
});

test("readResourceSamples returns an empty array when the file does not exist", () => {
  assert.deepEqual(readResourceSamples("/nonexistent/resource-samples.ndjson"), []);
});

test("readResourceSamples returns an empty array when no path is given", () => {
  assert.deepEqual(readResourceSamples(null), []);
});
