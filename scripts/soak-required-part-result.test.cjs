"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  requiredPartStatus,
  requiredPartFailureMessage,
} = require("./soak-required-part-result.cjs");

const SCRIPT_PATH = path.join(__dirname, "soak-required-part-result.cjs");

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

test("the enforcement command names failure, skipped, and cancelled distinctly", () => {
  const cases = [
    ["failure", /failed: inspect this run's artifact; this is not a cancellation/],
    ["skipped", /was skipped: it did not run and does not establish soak health/],
    ["cancelled", /was cancelled: its result is indeterminate/],
  ];
  for (const [result, expected] of cases) {
    const run = spawnSync(process.execPath, [SCRIPT_PATH, "--enforce"], {
      env: { ...process.env, NEEDS_JSON: JSON.stringify({ part_1: { result } }) },
      encoding: "utf8",
    });
    assert.strictEqual(run.status, 1, result);
    assert.match(run.stderr, expected, result);
  }
});

test("counterprobe: restoring the old always-cancelled mapping makes failure and skipped assertions fail", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nil-704-always-cancelled-"));
  const copiedScript = path.join(tempDir, "soak-required-part-result.cjs");
  fs.copyFileSync(SCRIPT_PATH, copiedScript);
  try {
    const source = fs.readFileSync(copiedScript, "utf8");
    const legacySource = source.replace(
      /function partResultMessage\(part, result\) \{[\s\S]*?\n\}\n\nfunction requiredPartFailureMessage/,
      'function partResultMessage() {\n  return "A cancelled part is indeterminate, not passed: check whether a newer run for the same SHA superseded it before diagnosing a product failure.";\n}\n\nfunction requiredPartFailureMessage',
    );
    assert.notStrictEqual(legacySource, source, "expected to replace the status mapping");
    fs.writeFileSync(copiedScript, legacySource);
    const probe = spawnSync(
      process.execPath,
      [
        "-e",
        `const { requiredPartFailureMessage } = require(process.argv[1]);\nfor (const [state, expected] of [["failure", /failed: inspect/], ["skipped", /was skipped/], ["cancelled", /was cancelled/]]) {\n  if (!expected.test(requiredPartFailureMessage({ part_1: { result: state } }))) throw new Error(\`missing \${state} message\`);\n}`,
        copiedScript,
      ],
      { encoding: "utf8" },
    );
    assert.notStrictEqual(
      probe.status,
      0,
      "legacy mapping unexpectedly passed all three assertions",
    );
    assert.match(probe.stderr, /missing (failure|skipped) message/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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
