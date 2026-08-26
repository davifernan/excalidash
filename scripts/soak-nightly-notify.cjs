#!/usr/bin/env node
// NIL-639: "wie wird ein Fehlschlag sichtbar, statt dass ein naechtlicher
// Lauf still rot bleibt?" -- posts every nightly result (pass or fail) as a
// comment on one pinned, durable tracking issue, found by title (created
// once if missing) rather than by a hardcoded number that would break if
// the issue were ever renumbered. A red Actions run nobody is watching is
// exactly the silent failure this ticket exists to close.

const { execFileSync } = require("child_process");
const fs = require("fs");

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const status = arg("status"); // "passed" | "failed"
const summaryFile = arg("summary-file");
const runUrl = arg("run-url");

const TITLE = "Nightly Team-Readiness Soak -- status (NIL-330 / NIL-639)";

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8" });
}

let issueNumber = null;
try {
  const list = JSON.parse(
    gh([
      "issue",
      "list",
      "--search",
      `"${TITLE}" in:title`,
      "--state",
      "open",
      "--json",
      "number,title",
    ]),
  );
  const exact = list.find((i) => i.title === TITLE);
  if (exact) issueNumber = exact.number;
} catch (err) {
  console.error(`soak-nightly-notify: issue lookup failed: ${err.message}`);
}

if (!issueNumber) {
  try {
    const body =
      "Pinned tracking issue for the nightly team-readiness soak (NIL-330's soak, split into four parts " +
      "per NIL-639). One comment per night, pass or fail -- do not close; the workflow keeps commenting here.";
    const created = gh(["issue", "create", "--title", TITLE, "--body", body]);
    const match = created.match(/\/issues\/(\d+)/);
    issueNumber = match ? match[1] : null;
  } catch (err) {
    console.error(`soak-nightly-notify: could not create tracking issue: ${err.message}`);
  }
}

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
const emoji = status === "passed" ? "🟢" : "🔴";
const commentBody = `${emoji} **${status.toUpperCase()}** -- [run](${runUrl})\n\n${summary}`;

try {
  gh(["issue", "comment", String(issueNumber), "--body", commentBody]);
  console.log(`soak-nightly-notify: commented on issue #${issueNumber}`);
} catch (err) {
  console.error(`soak-nightly-notify: failed to comment: ${err.message}`);
  process.exit(1);
}
