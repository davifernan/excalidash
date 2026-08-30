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

test("the enforcement command exits non-zero for skipped required parts", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "soak-required-part-result.cjs"), "--enforce"],
    {
      env: {
        ...process.env,
        NEEDS_JSON: JSON.stringify({ part_1: { result: "skipped" } }),
      },
      encoding: "utf8",
    },
  );
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
