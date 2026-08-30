#!/usr/bin/env node
"use strict";

// The nightly summary has two public consequences: its own job conclusion
// and the status posted to the tracking issue. Keep the required-part policy
// executable and shared so those two consequences cannot drift apart.

const NON_PASSING_RESULTS = new Set(["failure", "cancelled", "skipped"]);
const RESULT_DIAGNOSTICS = {
  failure:
    "A required soak part failed: inspect that part's logs before treating the aggregate as healthy.",
  skipped: "A required soak part was skipped: inspect why the required coverage did not run.",
  cancelled:
    "A cancelled part is indeterminate, not passed: check whether a newer run for the same SHA superseded it before diagnosing a product failure.",
};

function requiredPartStatus(needs) {
  const results = Object.values(needs || {}).map((job) => job && job.result);
  return results.some((result) => NON_PASSING_RESULTS.has(result)) ? "failed" : "passed";
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
    console.error(`Required soak part result: ${JSON.stringify(needs)}`);
    const results = new Set(Object.values(needs).map((job) => job && job.result));
    for (const result of NON_PASSING_RESULTS) {
      if (results.has(result)) console.error(RESULT_DIAGNOSTICS[result]);
    }
    return 1;
  }
  process.stdout.write(`${status}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { NON_PASSING_RESULTS, RESULT_DIAGNOSTICS, requiredPartStatus, main };
