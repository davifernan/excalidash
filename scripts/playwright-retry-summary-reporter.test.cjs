"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const PlaywrightRetrySummaryReporter = require("../e2e/playwright-retry-summary-reporter.cjs");

const REPOSITORY_ROOT = path.resolve(__dirname, "..");

const fakeTest = ({ id = "retry-test", project = "chromium", title = "suite › test" } = {}) => ({
  id,
  parent: { project: () => ({ name: project }) },
  titlePath: () => ["", "", ...title.split(" › ")],
});

const withSummary = (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "playwright-retry-summary-"));
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  return path.join(directory, "summary.md");
};

test("surfaces a retried test in the step summary and as an annotation", (t) => {
  const summaryPath = withSummary(t);
  const lines = [];
  const reporter = new PlaywrightRetrySummaryReporter({
    summaryPath,
    annotate: true,
    log: (message) => lines.push(message),
  });

  reporter.onTestEnd(fakeTest(), { retry: 0, status: "failed" });
  reporter.onTestEnd(fakeTest(), { retry: 1, status: "passed" });
  reporter.onEnd();

  assert.match(fs.readFileSync(summaryPath, "utf8"), /\| chromium \| suite › test \| 1 \| passed \|/);
  assert.ok(
    lines.includes(
      "::warning title=Playwright retry observed::suite › test required 1 retry. Final attempt: passed.",
    ),
  );
});

test("reports retries on stdout when no step summary exists", (t) => {
  const lines = [];
  const reporter = new PlaywrightRetrySummaryReporter({
    summaryPath: undefined,
    annotate: false,
    log: (message) => lines.push(message),
  });

  reporter.onTestEnd(fakeTest(), { retry: 2, status: "passed" });
  reporter.onEnd();

  // A local or Docker run has no GITHUB_STEP_SUMMARY. Reporting only there
  // would hide the retry exactly where the flake is debugged.
  assert.match(lines.join("\n"), /Playwright retries observed: 1 test/);
  assert.match(lines.join("\n"), /\[chromium\] suite › test — 2 retries, final attempt: passed/);
});

test("keeps the highest retry count and the graded attempt", (t) => {
  const summaryPath = withSummary(t);
  const reporter = new PlaywrightRetrySummaryReporter({ summaryPath, log: () => {} });

  reporter.onTestEnd(fakeTest(), { retry: 1, status: "failed" });
  reporter.onTestEnd(fakeTest(), { retry: 2, status: "failed" });
  reporter.onEnd();

  assert.match(fs.readFileSync(summaryPath, "utf8"), /\| chromium \| suite › test \| 2 \| failed \|/);
});

test("reports the same test id separately for each project", (t) => {
  const summaryPath = withSummary(t);
  const reporter = new PlaywrightRetrySummaryReporter({ summaryPath, log: () => {} });

  reporter.onTestEnd(fakeTest({ project: "chromium" }), { retry: 1, status: "passed" });
  reporter.onTestEnd(fakeTest({ project: "firefox" }), { retry: 2, status: "passed" });
  reporter.onEnd();

  const summary = fs.readFileSync(summaryPath, "utf8");
  assert.match(summary, /\| chromium \| suite › test \| 1 \| passed \|/);
  assert.match(summary, /\| firefox \| suite › test \| 2 \| passed \|/);
});

test("stays completely silent when every test passes on the first attempt", (t) => {
  const summaryPath = withSummary(t);
  const lines = [];
  const reporter = new PlaywrightRetrySummaryReporter({
    summaryPath,
    annotate: true,
    log: (message) => lines.push(message),
  });

  reporter.onTestEnd(fakeTest(), { retry: 0, status: "passed" });
  reporter.onEnd();

  // The counter-proof NIL-399 asks for: without this half, the evidence only
  // shows that more is reported, not that a retry is what triggers it.
  assert.equal(fs.existsSync(summaryPath), false);
  assert.deepEqual(lines, []);
});

test("the Playwright image does not override the configured reporter list", () => {
  const dockerfile = fs.readFileSync(
    path.join(REPOSITORY_ROOT, "e2e/Dockerfile.playwright"),
    "utf8",
  );

  // A CLI `--reporter` replaces the config's reporter list instead of extending
  // it, so the retry reporter is dropped wherever the flag is passed. This
  // guards that one regression only -- that the reporter actually fires is
  // proven by running the suite, not by reading this file.
  assert.doesNotMatch(dockerfile, /CMD .*--reporter/);
  assert.match(dockerfile, /COPY playwright-retry-summary-reporter\.cjs \.\//);
});
