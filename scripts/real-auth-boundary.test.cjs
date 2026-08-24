#!/usr/bin/env node
/**
 * Counterprobe for scripts/real-auth-boundary.cjs.
 *
 * Works entirely inside a private sandbox copy (same technique as
 * authz-boundary.test.cjs, NIL-493): the check computes its root as
 * path.resolve(__dirname, ".."), so pointing spawnSync at a copied script
 * makes its e2e/tests and e2e/playwright.config.ts resolve inside the
 * sandbox, never the real tree -- a probe here can add or remove a fake
 * spec file without any chance of colliding with a parallel test run.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { createSandbox, removeSandbox } = require("./test-helpers/sandbox-tree.cjs");

const repoRoot = path.resolve(__dirname, "..");

const withSandbox = (fn) => {
  const root = createSandbox(
    repoRoot,
    ["e2e/playwright.config.ts", "e2e/tests", "scripts/real-auth-boundary.cjs"],
    "real-auth-boundary-sandbox-",
  );
  try {
    return fn(root);
  } finally {
    removeSandbox(root);
  }
};

const run = (root) =>
  spawnSync("node", [path.join(root, "scripts", "real-auth-boundary.cjs")], {
    cwd: root,
    encoding: "utf8",
  });

const writeSpec = (root, filename, contents) => {
  fs.writeFileSync(path.join(root, "e2e", "tests", filename), contents, "utf8");
};

const removeSpec = (root, filename) => {
  fs.rmSync(path.join(root, "e2e", "tests", filename), { force: true });
};

test("ACCEPT: the real repo's e2e/tests holds today", () => {
  const result = spawnSync("node", [path.join(repoRoot, "scripts", "real-auth-boundary.cjs")], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

test("REJECT: a new spec importing toggleAuthEnabled is caught even when it is not registered", () => {
  withSandbox((root) => {
    writeSpec(
      root,
      "fake-unregistered.spec.ts",
      `import { toggleAuthEnabled } from "./helpers/authLifecycle";\n` +
        `toggleAuthEnabled(null, true);\n`,
    );
    const result = run(root);
    const output = `${result.stdout}${result.stderr}`;
    assert.notEqual(result.status, 0, "must fail: an unregistered real-auth spec exists");
    assert.match(output, /fake-unregistered\.spec\.ts/);
  });
});

test("REJECT: an ALIASED import of toggleAuthEnabled is still caught -- the check must not key on the call-site identifier", () => {
  withSandbox((root) => {
    writeSpec(
      root,
      "fake-aliased.spec.ts",
      `import { toggleAuthEnabled as flipRealAuthOn } from "./helpers/authLifecycle";\n` +
        `flipRealAuthOn(null, true);\n`,
    );
    const result = run(root);
    const output = `${result.stdout}${result.stderr}`;
    assert.notEqual(result.status, 0, "must fail: an aliased import is the same real switch");
    assert.match(output, /fake-aliased\.spec\.ts/);
  });
});

test("ACCEPT: a spec importing toggleAuthEnabled that IS registered in REAL_AUTH_SPECS does not cry wolf", () => {
  withSandbox((root) => {
    const configPath = path.join(root, "e2e", "playwright.config.ts");
    let config = fs.readFileSync(configPath, "utf8");
    config = config.replace(
      /const REAL_AUTH_SPECS = \[([\s\S]*?)\];/,
      (_match, entries) => `const REAL_AUTH_SPECS = [${entries}  "**/fake-registered.spec.ts",\n];`,
    );
    assert.notEqual(config.indexOf('"**/fake-registered.spec.ts"'), -1, "fixture edit did not apply");
    fs.writeFileSync(configPath, config, "utf8");
    writeSpec(
      root,
      "fake-registered.spec.ts",
      `import { toggleAuthEnabled } from "./helpers/authLifecycle";\n` +
        `toggleAuthEnabled(null, true);\n`,
    );
    const result = run(root);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  });
});

test("ACCEPT: a spec that merely mentions the helper in a comment, without importing it, is not flagged", () => {
  withSandbox((root) => {
    writeSpec(
      root,
      "fake-comment-only.spec.ts",
      `// see authLifecycle.ts for how toggleAuthEnabled works\n` +
        `export const x = 1;\n`,
    );
    const result = run(root);
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 0, output);
  });
});
