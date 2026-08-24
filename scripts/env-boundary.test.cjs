#!/usr/bin/env node
/**
 * Counterprobe for scripts/env-boundary.cjs (NIL-505).
 *
 * Same shape as logging-boundary.test.cjs: sandbox the tree so probes never
 * touch the real repo or race a concurrent test file, plant one real
 * violation per probe, require the check to name it, then prove the check
 * is clean again once every probe is gone. Every probe is a DATEIKOPIE-style
 * sandbox write, never a `git checkout --` against the real tree.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { createSandbox, removeSandbox } = require("./test-helpers/sandbox-tree.cjs");

const repoRoot = path.resolve(__dirname, "..");
const { SRC: REAL_SRC } = require("./env-boundary.cjs");

const root = createSandbox(
  repoRoot,
  [path.relative(repoRoot, REAL_SRC).split(path.sep).join("/"), "scripts/env-boundary.cjs"],
  "env-boundary-sandbox-",
);
const CHECK = path.join(root, "scripts", "env-boundary.cjs");
const PROBE_DIR = path.join(root, "backend", "src", "__env_probe__");

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

// Every syntactic shape a violation could take: plain property access, optional
// chaining, and the bracket/index form (the same lesson authz-boundary.cjs
// learned about `prisma["drawingPermission"]` -- a pattern anchored on the dot
// form alone would miss this one).
const probes = [
  ["plain property access", "plainAccess.ts", 'export const port = process.env.PORT;\n'],
  ["optional chaining", "optionalChain.ts", 'export const port = process.env?.PORT;\n'],
  ["bracket/index access", "bracketAccess.ts", 'export const port = process.env["PORT"];\n'],
  [
    "dynamic bracket access",
    "dynamicBracket.ts",
    'export const readNamed = (name: string) => process.env[name];\n',
  ],
];

const assertConfigFileNotFlagged = () => {
  // backend/src/config.ts itself reads process.env freely -- covered by
  // "green on the unmodified tree" in main(). This probe checks the OTHER
  // direction: a new file is never automatically allowed just because it
  // sits in backend/src root next to config.ts.
  assertRejects(
    "a new file in backend/src root that is not config.ts",
    "notConfig.ts",
    'export const probe = () => process.env.SOMETHING;\n',
  );
};

const assertConfigDirectoryAllowed = () => {
  // backend/src/config/ is allow-listed as a directory, not just the two
  // files that happen to live there today (passwordPolicy.ts, production.ts).
  // A NEW file added under that directory must be accepted too.
  const configDir = path.join(root, "backend", "src", "config");
  const probeFile = path.join(configDir, "__probe_new_config_file.ts");
  if (fs.existsSync(probeFile)) {
    throw new Error(`Refusing to reuse an existing probe file: ${probeFile}`);
  }
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(probeFile, "export const probe = () => process.env.ANYTHING;\n", "utf8");
  try {
    const result = run();
    const output = outputOf(result);
    const relative = "backend/src/config/__probe_new_config_file.ts";
    if (result.status === 0 && !output.includes(relative)) {
      console.log("  green on a new file under backend/src/config/");
      return;
    }
    throw new Error(`A new file under backend/src/config/ was rejected.\ngot exit ${result.status}\n${output}`);
  } finally {
    fs.rmSync(probeFile, { force: true });
  }
};

const assertConfigImportAccepted = () => {
  assertAccepted(
    "a file that imports and reads config.*",
    "usesConfig.ts",
    'import { config } from "../config";\nexport const probe = () => config.port;\n',
  );
};

const assertStaleExceptionEntryCaught = (setName, source, replaceLabel) => {
  const marker = `const ${setName} = new Set([`;
  if (!source.includes(marker)) {
    throw new Error(`Anchor for the stale-${replaceLabel} probe is missing from env-boundary.cjs.`);
  }
  const patchedPath = path.join(root, "scripts", `.env-boundary.stale-${replaceLabel}-probe.cjs`);
  const patched = source.replace(
    marker,
    `${marker}\n  "backend/src/__env_probe__/doesNotExistOrDoesNotReadEnv.ts",`,
  );
  if (patched === source) throw new Error(`Stale-${replaceLabel} patch did not change the script.`);
  fs.writeFileSync(patchedPath, patched, "utf8");
  try {
    const result = spawnSync("node", [patchedPath], { cwd: root, encoding: "utf8" });
    const output = outputOf(result);
    if (
      result.status === 1 &&
      output.includes("STALE") &&
      output.includes("doesNotExistOrDoesNotReadEnv.ts")
    ) {
      console.log(`  red on a stale ${replaceLabel} entry (listed but no longer reads process.env)`);
      return;
    }
    throw new Error(`Stale ${replaceLabel} entry was not caught.\ngot exit ${result.status}\n${output}`);
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
  assertConfigImportAccepted();
  assertConfigFileNotFlagged();
  assertConfigDirectoryAllowed();

  const source = fs.readFileSync(CHECK, "utf8");
  assertStaleExceptionEntryCaught("BASELINE", source, "baseline");
  assertStaleExceptionEntryCaught("STRUCTURAL_EXCEPTIONS", source, "structural-exception");

  const after = run();
  if (after.status !== 0) {
    throw new Error(`Probes were not cleaned up.\n${outputOf(after)}`);
  }
  console.log("  green again after every probe was removed");
  console.log("Env boundary check proved in both directions.");
};

try {
  main();
} finally {
  removeSandbox(root);
}
