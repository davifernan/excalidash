#!/usr/bin/env node
"use strict";

// The nightly summary has two public consequences: its own job conclusion
// and the status posted to the tracking issue. Keep the required-part policy
// executable and shared so those two consequences cannot drift apart.

const NON_PASSING_RESULTS = new Set(["failure", "cancelled", "skipped"]);

function requiredPartStatus(needs) {
  const results = Object.values(needs || {}).map((job) => job && job.result);
  return results.some((result) => NON_PASSING_RESULTS.has(result)) ? "failed" : "passed";
}

function partResultMessage(part, result) {
  switch (result) {
    case "failure":
      return `Required soak part ${part} failed: inspect this run's artifact; this is not a cancellation.`;
    case "skipped":
      return `Required soak part ${part} was skipped: it did not run and does not establish soak health.`;
    case "cancelled":
      return `Required soak part ${part} was cancelled: its result is indeterminate, so check whether a newer run for the same SHA superseded it before diagnosing a product failure.`;
    default:
      return null;
  }
}

function requiredPartFailureMessage(needs) {
  const messages = Object.entries(needs || {})
    .map(([part, job]) => partResultMessage(part, job && job.result))
    .filter(Boolean);
  return [`Required soak part result: ${JSON.stringify(needs)}`, ...messages].join("\n");
}

function main(args = process.argv.slice(2), needsJson = process.env.NEEDS_JSON) {
  const enforce = args.includes("--enforce");
  if (typeof needsJson !== "string") {
    console.error("soak-required-part-result: NEEDS_JSON was not provided");
    return 2;
  }

  let needs;
  try {
    needs = JSON.parse(needsJson);
  } catch {
    console.error("soak-required-part-result: NEEDS_JSON was not valid JSON");
    return 2;
  }

  const status = requiredPartStatus(needs);
  if (enforce && status === "failed") {
    console.error(requiredPartFailureMessage(needs));
    return 1;
  }
  process.stdout.write(`${status}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = {
  NON_PASSING_RESULTS,
  requiredPartStatus,
  partResultMessage,
  requiredPartFailureMessage,
  main,
};
