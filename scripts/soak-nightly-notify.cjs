#!/usr/bin/env node
// NIL-639: "wie wird ein Fehlschlag sichtbar, statt dass ein naechtlicher
// Lauf still rot bleibt?" -- posts every nightly result (pass or fail) as a
// comment on one pinned, durable tracking issue, found by a dedicated label
// (created once if missing) rather than by a hardcoded number that would
// break if the issue were ever renumbered. A red Actions run nobody is
// watching is exactly the silent failure this ticket exists to close.

const { execFileSync } = require("child_process");
const fs = require("fs");

const TITLE = "Nightly Team-Readiness Soak -- status (NIL-330 / NIL-639)";

// Hans-Friedrich question on #223: could `gh issue list --search "<title>"
// in:title` miss the tracking issue because of the title's own punctuation
// (--, /)? Measured live against this repo: GitHub issue search tokenizes,
// it is NOT a phrase match even when the query is quoted -- a query with a
// completely different word order still matched issue #216 by its title.
// So punctuation was never the risk. The real risk ran the other way: the
// old call set no --limit (gh's default is 30), so once more than 30 open
// issues shared a token with this title ("status", "soak", "team", ...),
// the real tracking issue could fall off the result page, `list.find(exact
// title)` would find nothing, and every night would silently create a
// fresh duplicate. Separately, `--state open` meant closing the tracking
// issue once produced a second one on the next run. A label sidesteps
// both: `gh issue list --label` is an exact match, not a token search, and
// `--state all` still finds a closed tracking issue (which still accepts
// comments -- no need to reopen it).
const TRACKING_LABEL = "nightly-soak-tracking";

// There should only ever be one issue carrying TRACKING_LABEL -- this just
// needs to be comfortably above that, explicit rather than left to gh's own
// default (30), so a future change to gh's default can't quietly reopen the
// exact failure mode this label switch exists to close.
const ISSUE_LIST_LIMIT = 100;

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function findTrackingIssue(gh) {
  const list = JSON.parse(
    gh([
      "issue",
      "list",
      "--label",
      TRACKING_LABEL,
      "--state",
      "all",
      "--limit",
      String(ISSUE_LIST_LIMIT),
      "--json",
      "number,title,state",
    ]),
  );
  return list.length > 0 ? list[0].number : null;
}

// A label must exist on the repo before `gh issue create --label` will
// accept it. `--force` makes this idempotent (updates the existing label
// rather than erroring) so this is safe to call every run, not just the
// first. Failure here is logged but never fatal -- a label hiccup must not
// block finding/creating the tracking issue itself.
function ensureLabelExists(gh) {
  try {
    gh([
      "label",
      "create",
      TRACKING_LABEL,
      "--color",
      "0e8a16",
      "--description",
      "Nightly team-readiness soak tracking issue (NIL-639) -- do not reuse on other issues",
      "--force",
    ]);
  } catch (err) {
    console.error(`soak-nightly-notify: label ensure failed (non-fatal): ${err.message}`);
  }
}

function createTrackingIssue(gh) {
  ensureLabelExists(gh);
  const body =
    "Pinned tracking issue for the nightly team-readiness soak (NIL-330's soak, split into four parts " +
    "per NIL-639). One comment per night, pass or fail -- do not close; the workflow keeps commenting " +
    `here. Found on later runs by the "${TRACKING_LABEL}" label, not by title -- do not remove the label.`;
  const created = gh([
    "issue",
    "create",
    "--title",
    TITLE,
    "--body",
    body,
    "--label",
    TRACKING_LABEL,
  ]);
  const match = created.match(/\/issues\/(\d+)/);
  return match ? match[1] : null;
}

function resolveTrackingIssueNumber(gh) {
  let issueNumber = null;
  try {
    issueNumber = findTrackingIssue(gh);
  } catch (err) {
    console.error(`soak-nightly-notify: issue lookup failed: ${err.message}`);
  }
  if (!issueNumber) {
    try {
      issueNumber = createTrackingIssue(gh);
    } catch (err) {
      console.error(`soak-nightly-notify: could not create tracking issue: ${err.message}`);
    }
  }
  return issueNumber;
}

function buildCommentBody(status, summary, runUrl) {
  const emoji = status === "passed" ? "🟢" : "🔴";
  return `${emoji} **${status.toUpperCase()}** -- [run](${runUrl})\n\n${summary}`;
}

function main() {
  const status = arg("status"); // "passed" | "failed"
  const summaryFile = arg("summary-file");
  const runUrl = arg("run-url");

  function gh(args) {
    return execFileSync("gh", args, { encoding: "utf8" });
  }

  const issueNumber = resolveTrackingIssueNumber(gh);
  if (!issueNumber) {
    console.error(
      "soak-nightly-notify: no tracking issue available, cannot post -- failing loudly instead of swallowing this",
    );
    process.exit(1);
  }

  const summary =
    summaryFile && fs.existsSync(summaryFile)
      ? fs.readFileSync(summaryFile, "utf8")
      : "(summary unavailable)";
  const commentBody = buildCommentBody(status, summary, runUrl);

  try {
    gh(["issue", "comment", String(issueNumber), "--body", commentBody]);
    console.log(`soak-nightly-notify: commented on issue #${issueNumber}`);
  } catch (err) {
    console.error(`soak-nightly-notify: failed to comment: ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  TITLE,
  TRACKING_LABEL,
  ISSUE_LIST_LIMIT,
  findTrackingIssue,
  ensureLabelExists,
  createTrackingIssue,
  resolveTrackingIssueNumber,
  buildCommentBody,
};
