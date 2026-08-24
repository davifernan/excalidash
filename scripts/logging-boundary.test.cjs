#!/usr/bin/env node
/**
 * Counterprobe for scripts/logging-boundary.cjs (NIL-502).
 *
 * Same shape as adapter-boundary.test.cjs: sandbox the tree so probes never
 * touch the real repo or race a concurrent test file, plant one real
 * violation per probe, require the check to name it, then prove the check
 * is clean again once every probe is gone.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { createSandbox, removeSandbox } = require("./test-helpers/sandbox-tree.cjs");

const repoRoot = path.resolve(__dirname, "..");
const { SRC: REAL_SRC } = require("./logging-boundary.cjs");

const root = createSandbox(
  repoRoot,
  [path.relative(repoRoot, REAL_SRC).split(path.sep).join("/"), "scripts/logging-boundary.cjs"],
  "logging-boundary-sandbox-",
);
const CHECK = path.join(root, "scripts", "logging-boundary.cjs");
const PROBE_DIR = path.join(root, "backend", "src", "__logging_probe__");

const run = () => spawnSync("node", [CHECK], { cwd: root, encoding: "utf8" });

const outputOf = (result) => `${result.stdout ?? ""}${result.stderr ?? ""}`;

const withProbeFile = (name, contents, callback) => {
  const file = path.join(PROBE_DIR, name);
  if (fs.existsSync(PROBE_DIR)) {
    throw new Error(`Refusing to reuse an existing probe directory: ${PROBE_DIR}`);
  }
  fs.mkdirSync(PROBE_DIR, { recursive: true });
  try {
    fs.writeFileSync(file, contents, "utf8");
    return callback(path.relative(root, file).split(path.sep).join("/"));
  } finally {
    fs.rmSync(PROBE_DIR, { recursive: true, force: true });
  }
};

const assertRejects = (label, name, contents) => {
  withProbeFile(name, contents, (relative) => {
    const result = run();
    const output = outputOf(result);
    if (result.status === 1 && output.includes(relative)) {
      console.log(`  red on ${label}: ${relative}`);
      return;
    }
    throw new Error(
      `${label} was NOT rejected.\nexpected exit 1 naming ${relative}\ngot exit ${result.status}\n${output}`,
    );
  });
};

const assertAccepted = (label, name, contents) => {
  withProbeFile(name, contents, (relative) => {
    const result = run();
    const output = outputOf(result);
    if (result.status === 0 && !output.includes(relative)) {
      console.log(`  green on ${label}: ${relative}`);
      return;
    }
    throw new Error(
      `${label} was rejected when it should not have been.\nexpected exit 0, ${relative} absent\n` +
        `got exit ${result.status}\n${output}`,
    );
  });
};

// The exact probe Nilo's own manual counterprobe used against the real tree
// (sharing.ts, NIL-502 PR), reproduced here as a mechanical, repeatable check
// instead of a one-off manual step.
const probes = [
  ["console.error", "consoleError.ts", 'export const probe = () => console.error("boom");\n'],
  ["console.log", "consoleLog.ts", 'export const probe = () => console.log("noisy");\n'],
  ["console.warn", "consoleWarn.ts", 'export const probe = () => console.warn("careful");\n'],
  ["console.debug", "consoleDebug.ts", 'export const probe = () => console.debug("trace");\n'],
  ["console.info", "consoleInfo.ts", 'export const probe = () => console.info("fyi");\n'],
];

const assertLoggerCallsAccepted = () => {
  assertAccepted(
    "a file that imports and calls logger.*",
    "usesLogger.ts",
    'import { logger } from "./logger";\nexport const probe = () => logger.error("boom", { requestId: "x" });\n',
  );
};

const assertStructuralExceptionNotFlagged = () => {
  // config.ts itself, already in STRUCTURAL_EXCEPTIONS, must not be flagged
  // by the unmodified tree -- covered by "green on the unmodified tree" in
  // main(). This probe checks the OTHER direction: a new file is never
  // automatically structural just because it looks like config.ts.
  assertRejects(
    "a new file that is not on either exception list",
    "notExempt.ts",
    'export const probe = () => console.error("not exempt just because it is new");\n',
  );
};

const assertStaleBaselineEntryCaught = () => {
  const source = fs.readFileSync(CHECK, "utf8");
  const marker = '"backend/src/utils/audit.ts",';
  if (!source.includes(marker)) {
    throw new Error("Anchor entry for the stale-baseline probe is missing from logging-boundary.cjs.");
  }
  const patchedPath = path.join(root, "scripts", ".logging-boundary.stale-probe.cjs");
  // Insert a baseline entry for a file that will not exist / will not call
  // console.* in this sandbox -- unlike a real migration, nothing needs to
  // change in backend/src for this probe.
  const patched = source.replace(
    marker,
    `${marker}\n  "backend/src/__logging_probe__/doesNotExistOrDoesNotCallConsole.ts",`,
  );
  if (patched === source) throw new Error("Stale-baseline patch did not change the script.");
  fs.writeFileSync(patchedPath, patched, "utf8");
  try {
    const result = spawnSync("node", [patchedPath], { cwd: root, encoding: "utf8" });
    const output = outputOf(result);
    if (result.status === 1 && output.includes("STALE") && output.includes("doesNotExistOrDoesNotCallConsole.ts")) {
      console.log("  red on a stale baseline entry (listed but no longer calls console.*)");
      return;
    }
    throw new Error(`Stale baseline entry was not caught.\ngot exit ${result.status}\n${output}`);
  } finally {
    fs.rmSync(patchedPath, { force: true });
  }
};

const main = () => {
  const clean = run();
  if (clean.status !== 0) {
    throw new Error(`The tree should pass before probing.\n${outputOf(clean)}`);
  }
  console.log("  green on the unmodified tree");

  for (const [label, name, contents] of probes) assertRejects(label, name, contents);
  assertLoggerCallsAccepted();
  assertStructuralExceptionNotFlagged();
  assertStaleBaselineEntryCaught();

  const after = run();
  if (after.status !== 0) {
    throw new Error(`Probes were not cleaned up.\n${outputOf(after)}`);
  }
  console.log("  green again after every probe was removed");
  console.log("Logging boundary check proved in both directions.");
};

try {
  main();
} finally {
  removeSandbox(root);
}
