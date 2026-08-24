const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const SCRIPT = path.join(__dirname, "excalidraw-canary-check.cjs");

const writeExecutable = (file, source) => {
  fs.writeFileSync(file, `#!/usr/bin/env node\n${source}`);
  fs.chmodSync(file, 0o755);
};

const runWithFakeCommands = ({
  installExitCode = 0,
  npxExitCode = 0,
  restoreExitCode = 0,
  testResults = [],
}) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "excalidraw-canary-test-"));
  const npmLog = path.join(tempDir, "npm-calls.jsonl");
  const npxLog = path.join(tempDir, "npx-calls.jsonl");

  try {
    writeExecutable(
      path.join(tempDir, "npm"),
      `
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CANARY_NPM_LOG, JSON.stringify(args) + "\\n");
process.exit(args[0] === "install" ? ${installExitCode} : ${restoreExitCode});
`,
    );
    writeExecutable(
      path.join(tempDir, "npx"),
      `
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CANARY_NPX_LOG, JSON.stringify(args) + "\\n");
const testResults = ${JSON.stringify(testResults)};
if (testResults !== null) {
  const outputArg = args.find((arg) => arg.startsWith("--outputFile="));
  if (outputArg) {
    fs.writeFileSync(outputArg.slice("--outputFile=".length), JSON.stringify({ testResults }));
  }
}
process.exit(${npxExitCode});
`,
    );

    const result = spawnSync(process.execPath, [SCRIPT, "0.18.0"], {
      encoding: "utf8",
      env: {
        ...process.env,
        CANARY_NPM_LOG: npmLog,
        CANARY_NPX_LOG: npxLog,
        PATH: `${tempDir}${path.delimiter}${process.env.PATH}`,
      },
    });
    const npmCalls = fs
      .readFileSync(npmLog, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const npxCalls = fs.existsSync(npxLog)
      ? fs
          .readFileSync(npxLog, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];

    return { npmCalls, npxCalls, result };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
};

test("restores the pinned install when npm install fails", () => {
  const { npmCalls, result } = runWithFakeCommands({ installExitCode: 42, npxExitCode: 0 });

  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(
    npmCalls,
    [
      ["install", "@excalidraw/excalidraw@0.18.0", "--no-save"],
      ["ci", "--no-audit", "--no-fund"],
    ],
    "restore npm ci must run after npm install fails",
  );
});

test("restores the pinned install when the seam suite fails before producing a report", () => {
  const { npmCalls, result } = runWithFakeCommands({ npxExitCode: 43, testResults: null });

  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(
    npmCalls,
    [
      ["install", "@excalidraw/excalidraw@0.18.0", "--no-save"],
      ["ci", "--no-audit", "--no-fund"],
    ],
    "restore npm ci must run after the seam suite aborts",
  );
});

test("reports a real seam mismatch from Vitest's assertion results", () => {
  const seamTitle = "the installed Excalidraw changed the toolbar seam";
  const { npmCalls, result } = runWithFakeCommands({
    npxExitCode: 1,
    testResults: [{ assertionResults: [{ status: "failed", title: seamTitle }] }],
  });

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Canary result: seam-mismatch/);
  assert.ok(result.stderr.includes(`- ${seamTitle}`), "the broken seam must be named verbatim");
  assert.deepEqual(npmCalls, [
    ["install", "@excalidraw/excalidraw@0.18.0", "--no-save"],
    ["ci", "--no-audit", "--no-fund"],
  ]);
});

test("reports when restoring the pinned install itself fails", () => {
  const { npmCalls, result } = runWithFakeCommands({ restoreExitCode: 44 });

  assert.equal(result.status, 1, result.stderr);
  assert.match(
    result.stderr,
    /Canary result: restore-failed; the swapped Excalidraw install may still be present/,
  );
  assert.deepEqual(npmCalls, [
    ["install", "@excalidraw/excalidraw@0.18.0", "--no-save"],
    ["ci", "--no-audit", "--no-fund"],
  ]);
});

test("runs the real-render compatibility test against the swapped package", () => {
  const { npxCalls, result } = runWithFakeCommands({});

  assert.equal(result.status, 0, result.stderr);
  assert.equal(npxCalls.length, 1);
  assert.ok(
    npxCalls[0].includes("src/integrations/excalidraw/compatibility/seams.integration.test.tsx"),
    "the Canary must execute the test that mounts the real Excalidraw component",
  );
});
