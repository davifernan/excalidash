"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

/**
 * NIL-639 Hans finding on #223: soak-nightly-aggregate.cjs's evidence-branch
 * PUT (the whole point of the nightly run -- a durable, growing raw-numbers
 * log) was wrapped in a try/catch that only logged the failure. A 403 (the
 * two soak workflow files declared no `permissions:` block at all) left the
 * "Aggregate this run's parts..." step green while the evidence log never
 * grew -- the exact "reported green, measured nothing" failure this repo
 * already hit twice before (readPartSummary's artifact path, the missing
 * RSS/swap/CPU capture). This does not unit-test a helper function -- it
 * spawns the real script as a subprocess, with a fake `gh` on PATH that
 * fails the PUT like a 403 would, and asserts the process itself exits
 * non-zero. Reverting the fix in soak-nightly-aggregate.cjs (restoring the
 * bare catch-and-log around the PUT) turns this test red without touching
 * this file.
 */

const SCRIPT_PATH = path.join(__dirname, "soak-nightly-aggregate.cjs");

// A fake `gh` covering exactly the two calls soak-nightly-aggregate.cjs
// makes: `api .../contents/<path>?ref=evidence` (GET, read the existing
// log) and `api .../contents/<path> --input <file> -X PUT` (the write).
// GET_MODE controls whether the read succeeds (existing log) or fails (no
// log yet, the script's own documented "starting one" path); PUT_MODE
// controls whether the write succeeds or fails like a permissions error.
function writeFakeGh(dir, { getMode, putMode }) {
  const ghPath = path.join(dir, "gh");
  fs.writeFileSync(
    ghPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const isPut = args.includes("-X") && args[args.indexOf("-X") + 1] === "PUT";
if (isPut) {
  if ("${putMode}" === "fail") {
    process.stderr.write("HTTP 403: Resource not accessible by integration\\n");
    process.exit(1);
  }
  process.exit(0);
}
// GET (read current evidence log)
if ("${getMode}" === "fail") {
  process.stderr.write("HTTP 404: Not Found\\n");
  process.exit(1);
}
process.stdout.write(JSON.stringify({ sha: "abc123", content: Buffer.from("").toString("base64") }));
process.exit(0);
`,
    { mode: 0o755 },
  );
  return ghPath;
}

function runAggregateScript({ getMode, putMode }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "soak-evidence-test-"));
  const resultsDir = path.join(tmpDir, "soak-results");
  fs.mkdirSync(resultsDir, { recursive: true });
  writeFakeGh(tmpDir, { getMode, putMode });

  const result = spawnSync(process.execPath, [SCRIPT_PATH], {
    env: {
      ...process.env,
      PATH: `${tmpDir}:${process.env.PATH}`,
      SOAK_RESULTS_DIR: resultsDir,
      GITHUB_REPOSITORY: "example/repo",
      GITHUB_SHA: "deadbeef",
      RUN_URL: "https://example.invalid/run/1",
      CONTEXT_COUNT: "10",
      ENGINES: "chromium",
      PART_DURATION_MINUTES: "115",
    },
    encoding: "utf8",
  });

  fs.rmSync(tmpDir, { recursive: true, force: true });
  return result;
}

test("soak-nightly-aggregate.cjs exits non-zero when the evidence-branch write fails", () => {
  const result = runAggregateScript({ getMode: "fail", putMode: "fail" });
  assert.notStrictEqual(
    result.status,
    0,
    `expected a non-zero exit when the evidence PUT fails, got ${result.status}. stderr:\n${result.stderr}`,
  );
  assert.match(result.stderr, /failed to write evidence log/);
});

test("soak-nightly-aggregate.cjs still writes summary.md when the evidence write fails", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "soak-evidence-test-"));
  const resultsDir = path.join(tmpDir, "soak-results");
  fs.mkdirSync(resultsDir, { recursive: true });
  writeFakeGh(tmpDir, { getMode: "fail", putMode: "fail" });

  spawnSync(process.execPath, [SCRIPT_PATH], {
    env: {
      ...process.env,
      PATH: `${tmpDir}:${process.env.PATH}`,
      SOAK_RESULTS_DIR: resultsDir,
      GITHUB_REPOSITORY: "example/repo",
      CONTEXT_COUNT: "10",
      ENGINES: "chromium",
      PART_DURATION_MINUTES: "115",
    },
    encoding: "utf8",
  });

  assert.ok(
    fs.existsSync(path.join(resultsDir, "summary.md")),
    "summary.md must still be written so the tracking-issue comment step (if: always()) has something to post",
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("soak-nightly-aggregate.cjs exits zero when the evidence-branch write succeeds", () => {
  const result = runAggregateScript({ getMode: "fail", putMode: "succeed" });
  assert.strictEqual(
    result.status,
    0,
    `expected exit 0 when the evidence PUT succeeds, got ${result.status}. stderr:\n${result.stderr}`,
  );
});
