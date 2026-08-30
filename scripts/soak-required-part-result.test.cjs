"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { requiredPartStatus } = require("./soak-required-part-result.cjs");

test("a required skipped part is failed rather than passed", () => {
  assert.strictEqual(
    requiredPartStatus({
      part_1: { result: "skipped" },
      part_2: { result: "skipped" },
      part_3: { result: "skipped" },
      part_4: { result: "skipped" },
    }),
    "failed",
  );
});

test("all successful required parts are passed", () => {
  assert.strictEqual(
    requiredPartStatus({
      part_1: { result: "success" },
      part_2: { result: "success" },
      part_3: { result: "success" },
      part_4: { result: "success" },
    }),
    "passed",
  );
});

function runEnforcement(result) {
  return spawnSync(
    process.execPath,
    [path.join(__dirname, "soak-required-part-result.cjs"), "--enforce"],
    {
      env: {
        ...process.env,
        NEEDS_JSON: JSON.stringify({ part_1: { result } }),
      },
      encoding: "utf8",
    },
  );
}

test("the enforcement command describes skipped required parts as skipped", () => {
  const result = runEnforcement("skipped");
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /required soak part was skipped/i);
  assert.doesNotMatch(result.stderr, /indeterminate, not passed/);
});

test("the enforcement command describes failed required parts as failed", () => {
  const result = runEnforcement("failure");
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /required soak part failed/i);
  assert.doesNotMatch(result.stderr, /indeterminate, not passed/);
});

test("the enforcement command treats cancelled required parts as indeterminate", () => {
  const result = runEnforcement("cancelled");
  assert.strictEqual(result.status, 1);
  assert.match(result.stderr, /indeterminate, not passed/);
});

test("the enforcement command rejects missing needs input", () => {
  const env = { ...process.env };
  delete env.NEEDS_JSON;
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "soak-required-part-result.cjs"), "--enforce"],
    { env, encoding: "utf8" },
  );
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /NEEDS_JSON was not provided/);
});
