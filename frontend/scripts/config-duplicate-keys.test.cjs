#!/usr/bin/env node
/**
 * Counterprobe for config-duplicate-keys.cjs (NIL-708).
 *
 * Each probe begins by copying a real repository configuration into a private
 * temporary directory, then adds a duplicate to that copy. No working-tree
 * configuration is changed and no git checkout/reset participates in either
 * red proof.
 */

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const frontendRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(frontendRoot, "..");
const check = path.join(__dirname, "config-duplicate-keys.cjs");
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "nil-708-config-keys-"));

const run = (...files) =>
  spawnSync("node", [check, ...files], {
    cwd: frontendRoot,
    encoding: "utf8",
  });

const assertRejected = (label, file) => {
  const result = run(file);
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.equal(result.status, 1, `${label} should fail\n${output}`);
  assert.match(
    output,
    /duplicate key|duplicated mapping key/i,
    `${label} should name the duplicate\n${output}`,
  );
};

try {
  const clean = run();
  assert.equal(clean.status, 0, `clean repository should pass\n${clean.stderr ?? ""}`);
  assert.equal(`${clean.stdout ?? ""}${clean.stderr ?? ""}`, "", "clean guard should be silent");

  const jsonProbe = path.join(sandbox, "knip.json");
  fs.copyFileSync(path.join(frontendRoot, "knip.json"), jsonProbe);
  const jsonSource = fs.readFileSync(jsonProbe, "utf8");
  assert.match(jsonSource, /\n}\s*$/);
  fs.writeFileSync(
    jsonProbe,
    jsonSource.replace(/\n}\s*$/, ',\n  "ignoreDependencies": []\n}\n'),
    "utf8",
  );
  assertRejected("JSON duplicate key", jsonProbe);

  const yamlProbe = path.join(sandbox, "workflow.yml");
  fs.copyFileSync(path.join(repoRoot, ".github", "workflows", "test.yml"), yamlProbe);
  fs.appendFileSync(yamlProbe, "\nname: duplicate workflow name\n");
  assertRejected("YAML duplicate key", yamlProbe);

  const jsProbe = path.join(sandbox, "vite.config.ts");
  fs.copyFileSync(path.join(frontendRoot, "vite.config.ts"), jsProbe);
  fs.appendFileSync(jsProbe, "\nconst nil708Probe = { resolve: {}, resolve: {} };\n");
  assertRejected("JS/TS duplicate key", jsProbe);
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
