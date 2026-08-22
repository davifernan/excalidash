"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const PlaywrightRetrySummaryReporter = require("../e2e/playwright-retry-summary-reporter.cjs");

const REPOSITORY_ROOT = path.resolve(__dirname, "..");

function fakeTest({ id = "retry-test", project = "chromium", title = "suite › test" } = {}) {
  return {
    id,
    parent: {
      project: () => ({ name: project }),
    },
    titlePath: () => ["", "", ...title.split(" › ")],
  };
}

function withSummary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "playwright-retry-summary-"));
  const summaryPath = path.join(directory, "summary.md");
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  return summaryPath;
}

test("reports a retried test without empty title-path segments", (t) => {
  const summaryPath = withSummary(t);
  const annotations = [];
  const reporter = new PlaywrightRetrySummaryReporter({
    summaryPath,
    log: (message) => annotations.push(message),
  });

  reporter.onTestEnd(fakeTest(), { retry: 0, status: "failed" });
  reporter.onTestEnd(fakeTest(), { retry: 1, status: "passed" });
  reporter.onEnd();

  const summary = fs.readFileSync(summaryPath, "utf8");
  assert.match(summary, /Playwright retries observed/);
  assert.match(summary, /\| chromium \| suite › test \| 1 \| passed \|/);
  assert.deepEqual(annotations, [
    "::warning title=Playwright retry observed::suite › test required 1 retry. Final attempt: passed.",
  ]);
});

test("keeps the largest retry count and final status for a repeatedly failing test", (t) => {
  const summaryPath = withSummary(t);
  const reporter = new PlaywrightRetrySummaryReporter({ summaryPath, log: () => {} });

  reporter.onTestEnd(fakeTest(), { retry: 1, status: "failed" });
  reporter.onTestEnd(fakeTest(), { retry: 2, status: "failed" });
  reporter.onEnd();

  assert.match(
    fs.readFileSync(summaryPath, "utf8"),
    /\| chromium \| suite › test \| 2 \| failed \|/,
  );
});

test("reports the same test id independently for each browser project", (t) => {
  const summaryPath = withSummary(t);
  const reporter = new PlaywrightRetrySummaryReporter({ summaryPath, log: () => {} });

  reporter.onTestEnd(fakeTest({ project: "chromium" }), { retry: 1, status: "passed" });
  reporter.onTestEnd(fakeTest({ project: "firefox" }), { retry: 2, status: "passed" });
  reporter.onEnd();

  const summary = fs.readFileSync(summaryPath, "utf8");
  assert.match(summary, /\| chromium \| suite › test \| 1 \| passed \|/);
  assert.match(summary, /\| firefox \| suite › test \| 2 \| passed \|/);
});

test("does not emit a summary or annotation when every test passes first try", (t) => {
  const summaryPath = withSummary(t);
  const annotations = [];
  const reporter = new PlaywrightRetrySummaryReporter({
    summaryPath,
    log: (message) => annotations.push(message),
  });

  reporter.onTestEnd(fakeTest(), { retry: 0, status: "passed" });
  reporter.onEnd();

  assert.equal(fs.existsSync(summaryPath), false);
  assert.deepEqual(annotations, []);
});

test("both retry-enabled Playwright suites install the reporter", () => {
  const e2eConfig = fs.readFileSync(path.join(REPOSITORY_ROOT, "e2e/playwright.config.ts"), "utf8");
  const frontendConfig = fs.readFileSync(
    path.join(REPOSITORY_ROOT, "frontend/playwright.config.ts"),
    "utf8",
  );
  const dockerfile = fs.readFileSync(
    path.join(REPOSITORY_ROOT, "e2e/Dockerfile.playwright"),
    "utf8",
  );

  assert.match(e2eConfig, /retries: process\.env\.CI \? 2 : 0/);
  assert.match(e2eConfig, /\.\/playwright-retry-summary-reporter\.cjs/);
  assert.match(frontendConfig, /retries: process\.env\.CI \? 2 : 0/);
  assert.match(frontendConfig, /\.\.\/e2e\/playwright-retry-summary-reporter\.cjs/);
  assert.match(dockerfile, /COPY playwright-retry-summary-reporter\.cjs \.\//);
});
