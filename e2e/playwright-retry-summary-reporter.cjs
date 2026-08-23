"use strict";

const fs = require("node:fs");

// A retry is a distinct outcome, not a detail. `retries: process.env.CI ? 2 : 0`
// means a green E2E check says "passed at least once out of up to three
// attempts", and nothing in the result distinguishes that from "passed first
// try". This reporter keeps the retry budget -- infrastructure flake should not
// block the queue -- while making every retry visible without opening the log.

const escapeWorkflowCommand = (value) =>
  String(value).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

const escapeMarkdownCell = (value) =>
  String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ");

const pluralizeRetries = (count) => `${count} ${count === 1 ? "retry" : "retries"}`;

class PlaywrightRetrySummaryReporter {
  constructor(options = {}) {
    this.summaryPath = options.summaryPath ?? process.env.GITHUB_STEP_SUMMARY;
    this.annotate = options.annotate ?? process.env.GITHUB_ACTIONS === "true";
    this.log = options.log || console.log;
    this.retriedTests = new Map();
  }

  onTestEnd(test, result) {
    if (!Number.isInteger(result.retry) || result.retry <= 0) return;

    const title = test.titlePath().filter(Boolean).join(" › ");
    const project = test.parent?.project()?.name || "default";
    const key = `${project}:${test.id || title}`;
    const previous = this.retriedTests.get(key);

    // Playwright calls this once per attempt. The last attempt carries both the
    // highest retry index and the outcome the run was graded on.
    if (!previous || result.retry >= previous.retries) {
      this.retriedTests.set(key, { project, retries: result.retry, status: result.status, title });
    }
  }

  onEnd() {
    if (this.retriedTests.size === 0) return;

    const retriedTests = [...this.retriedTests.values()].sort((left, right) =>
      left.title.localeCompare(right.title),
    );

    // Always on stdout: a local or Docker run has no step summary, and a retry
    // that only shows up on GitHub is invisible exactly where it is debugged.
    this.log(
      `Playwright retries observed: ${retriedTests.length} ${retriedTests.length === 1 ? "test" : "tests"} settled only after being retried.`,
    );
    for (const { project, retries, status, title } of retriedTests) {
      this.log(`  [${project}] ${title} — ${pluralizeRetries(retries)}, final attempt: ${status}`);
    }

    if (this.annotate) {
      for (const { retries, status, title } of retriedTests) {
        this.log(
          `::warning title=Playwright retry observed::${escapeWorkflowCommand(title)} required ${pluralizeRetries(retries)}. Final attempt: ${escapeWorkflowCommand(status)}.`,
        );
      }
    }

    if (this.summaryPath) {
      const rows = retriedTests.map(
        ({ project, retries, status, title }) =>
          `| ${escapeMarkdownCell(project)} | ${escapeMarkdownCell(title)} | ${retries} | ${escapeMarkdownCell(status)} |`,
      );
      fs.appendFileSync(
        this.summaryPath,
        [
          "",
          "## Playwright retries observed",
          "",
          "The E2E job settled only after one or more tests were retried. A retry is a distinct signal, even when the check is green.",
          "",
          "| Project | Test | Retries | Final attempt |",
          "| --- | --- | ---: | --- |",
          ...rows,
          "",
        ].join("\n"),
        "utf8",
      );
    }
  }
}

module.exports = PlaywrightRetrySummaryReporter;
