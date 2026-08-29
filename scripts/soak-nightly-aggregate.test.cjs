#!/usr/bin/env node
const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  sameProfile,
  median,
  p95,
  buildAggregate,
  matchingPassedRuns,
  metricsSection,
  buildSummaryMarkdown,
} = require("./soak-nightly-aggregate.cjs");

test("median handles both odd and even sample counts", () => {
  assert.equal(median([1, 3, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([5]), 5);
});

test("p95 picks the last element for small samples rather than throwing on rounding", () => {
  assert.equal(p95([1, 2, 3]), 3);
  assert.equal(p95([10]), 10);
});

test("sameProfile requires context count, engines, and part duration to all match", () => {
  const base = { context_count: "10", engines: "chromium,firefox", part_duration_minutes: "115" };
  assert.equal(sameProfile(base, { ...base }), true);
  assert.equal(sameProfile(base, { ...base, context_count: "6" }), false);
  assert.equal(sameProfile(base, { ...base, engines: "chromium" }), false);
});

test("buildAggregate treats a missing part as not-passed and does not count its cycles", () => {
  const parts = [
    {
      part: 1,
      passed: true,
      cycles: 10,
      watchdogViolations: 0,
      errorCount: 0,
      actualElapsedMs: 1000,
    },
    { part: 2, missing: true, passed: false },
    {
      part: 3,
      passed: true,
      cycles: 8,
      watchdogViolations: 1,
      errorCount: 2,
      actualElapsedMs: 900,
    },
    {
      part: 4,
      passed: true,
      cycles: 9,
      watchdogViolations: 0,
      errorCount: 0,
      actualElapsedMs: 950,
    },
  ];
  const agg = buildAggregate(parts, { context_count: "10" }, { ts: "t", sha: "s", runUrl: "u" });
  assert.equal(agg.allPassed, false);
  assert.equal(agg.totalCycles, 27);
  assert.equal(agg.totalWatchdogViolations, 1);
  assert.equal(agg.totalErrors, 2);
});

test("buildAggregate reports the peak RSS/swap across parts, ignoring a missing part", () => {
  const parts = [
    { part: 1, passed: true, resources: { peakMemUsedMB: 6000, peakSwapUsedMB: 100 } },
    { part: 2, missing: true, passed: false },
    { part: 3, passed: true, resources: { peakMemUsedMB: 9000, peakSwapUsedMB: 4000 } },
    { part: 4, passed: true, resources: { peakMemUsedMB: 7000, peakSwapUsedMB: 500 } },
  ];
  const agg = buildAggregate(parts, { context_count: "10" }, { ts: "t", sha: "s", runUrl: "u" });
  assert.equal(agg.peakMemUsedMB, 9000);
  assert.equal(agg.peakSwapUsedMB, 4000);
});

test("buildAggregate reports null peaks when no part carried a resources field", () => {
  const parts = [{ part: 1, passed: true }];
  const agg = buildAggregate(parts, { context_count: "10" }, { ts: "t", sha: "s", runUrl: "u" });
  assert.equal(agg.peakMemUsedMB, null);
  assert.equal(agg.peakSwapUsedMB, null);
});

test("matchingPassedRuns excludes failed runs from the same profile and includes a passed current run", () => {
  const profile = {
    context_count: "10",
    engines: "chromium,firefox",
    part_duration_minutes: "115",
  };
  const priorPassed = { profile, allPassed: true, totalElapsedMs: 1000, totalCycles: 5 };
  const priorFailed = { profile, allPassed: false, totalElapsedMs: 500, totalCycles: 2 };
  const priorDifferentProfile = {
    profile: { ...profile, context_count: "6" },
    allPassed: true,
    totalElapsedMs: 1,
    totalCycles: 1,
  };
  const thisRun = { profile, allPassed: true, totalElapsedMs: 1200, totalCycles: 6 };

  const matched = matchingPassedRuns(
    [priorPassed, priorFailed, priorDifferentProfile],
    profile,
    thisRun,
  );
  assert.equal(matched.length, 2);
  assert.ok(matched.includes(priorPassed));
  assert.ok(matched.includes(thisRun));
});

test("matchingPassedRuns does not include a failed current run", () => {
  const profile = {
    context_count: "10",
    engines: "chromium,firefox",
    part_duration_minutes: "115",
  };
  const priorPassed = { profile, allPassed: true, totalElapsedMs: 1000, totalCycles: 5 };
  const thisFailedRun = { profile, allPassed: false, totalElapsedMs: 1200, totalCycles: 6 };
  const matched = matchingPassedRuns([priorPassed], profile, thisFailedRun);
  assert.equal(matched.length, 1);
  assert.equal(matched[0], priorPassed);
});

test("metricsSection refuses to report a number below 3 same-profile runs", () => {
  const profile = {
    context_count: "10",
    engines: "chromium,firefox",
    part_duration_minutes: "115",
  };
  const lines = metricsSection([{ totalElapsedMs: 1, totalCycles: 1 }], profile);
  assert.ok(lines.some((l) => l.includes("1 of the required 3")));
  assert.ok(lines.every((l) => !l.includes("Median/p95 across")));
});

test("metricsSection reports median/p95 once 3 same-profile passed runs exist", () => {
  const profile = {
    context_count: "10",
    engines: "chromium,firefox",
    part_duration_minutes: "115",
  };
  const runs = [
    { totalElapsedMs: 1000, totalCycles: 10 },
    { totalElapsedMs: 2000, totalCycles: 20 },
    { totalElapsedMs: 3000, totalCycles: 30 },
  ];
  const lines = metricsSection(runs, profile);
  assert.ok(lines[0].includes("Median/p95 across 3 same-profile passed runs"));
  assert.ok(lines.some((l) => l.includes("median 2s")));
});

function makeRun(overrides = {}) {
  return {
    ts: "2026-08-28T00:00:00.000Z",
    allPassed: true,
    totalCycles: 10,
    totalWatchdogViolations: 0,
    totalErrors: 0,
    totalElapsedMs: 1000,
    peakMemUsedMB: 5000,
    peakSwapUsedMB: 0,
    profile: { context_count: "10", engines: "chromium,firefox", part_duration_minutes: "115" },
    ...overrides,
  };
}

test("buildSummaryMarkdown reports PASSED when all parts passed and the evidence write succeeded", () => {
  const md = buildSummaryMarkdown(makeRun(), [], ["some metrics line"], null);
  assert.match(md, /^# Nightly team-readiness soak/);
  assert.match(md, /Overall: PASSED/);
  assert.match(md, /Evidence log write: appended/);
});

test("buildSummaryMarkdown reports FAILED and names the error when the evidence write failed, even with all parts passing", () => {
  const md = buildSummaryMarkdown(
    makeRun({ allPassed: true }),
    [],
    ["some metrics line"],
    new Error("HTTP 403: Resource not accessible by integration"),
  );
  // Hans-Friedrich finding on #223: all parts passing must NOT read as a
  // clean PASSED when the evidence log itself failed to write.
  assert.match(md, /Overall: FAILED/);
  assert.doesNotMatch(md, /Overall: PASSED/);
  assert.match(md, /Evidence log write: FAILED -- HTTP 403/);
  assert.match(md, /NOT durably recorded/);
});

test("buildSummaryMarkdown still reports FAILED when parts failed, independent of the evidence write", () => {
  const md = buildSummaryMarkdown(makeRun({ allPassed: false }), [], ["x"], null);
  assert.match(md, /Overall: FAILED/);
  assert.match(md, /Evidence log write: appended/);
});
