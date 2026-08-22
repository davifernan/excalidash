"use strict";

const fs = require("node:fs");

function escapeWorkflowCommand(value) {
  return String(value).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function escapeMarkdownCell(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replaceAll("\r", " ")
    .replaceAll("\n", " ");
}

function pluralizeRetries(count) {
  return `${count} ${count === 1 ? "retry" : "retries"}`;
}

class PlaywrightRetrySummaryReporter {
  constructor(options = {}) {
    this.summaryPath = options.summaryPath || process.env.GITHUB_STEP_SUMMARY;
    this.log = options.log || console.log;
    this.retriedTests = new Map();
  }

  onTestEnd(test, result) {
    if (!Number.isInteger(result.retry) || result.retry <= 0) {
      return;
    }

    const title = test.titlePath().filter(Boolean).join(" › ");
    const project = test.parent.project()?.name || "default";
    const key = `${project}:${test.id || title}`;
    const previous = this.retriedTests.get(key);

    if (!previous || result.retry >= previous.retries) {
      this.retriedTests.set(key, {
        project,
        retries: result.retry,
        status: result.status,
        title,
      });
    }
  }

  onEnd() {
    if (!this.summaryPath || this.retriedTests.size === 0) {
      return;
    }

    const retriedTests = [...this.retriedTests.values()].sort((left, right) =>
      left.title.localeCompare(right.title),
    );
    const rows = retriedTests.map(
      ({ project, retries, status, title }) =>
        `| ${escapeMarkdownCell(project)} | ${escapeMarkdownCell(title)} | ${retries} | ${escapeMarkdownCell(status)} |`,
    );
    const summary = [
      "",
      "## ⚠️ Playwright retries observed",
      "",
      "The E2E job passed or failed only after one or more tests were retried. A retry is a distinct CI signal, even when the final check is green.",
      "",
      "| Project | Test | Retries | Final attempt |",
      "| --- | --- | ---: | --- |",
      ...rows,
      "",
    ].join("\n");

    fs.appendFileSync(this.summaryPath, summary, "utf8");

    for (const { retries, status, title } of retriedTests) {
      this.log(
        `::warning title=Playwright retry observed::${escapeWorkflowCommand(title)} required ${pluralizeRetries(retries)}. Final attempt: ${escapeWorkflowCommand(status)}.`,
      );
    }
  }
}

module.exports = PlaywrightRetrySummaryReporter;
