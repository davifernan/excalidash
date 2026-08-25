#!/usr/bin/env node
/**
 * Counterprobe for scripts/cors-header-boundary.cjs (NIL-586).
 *
 * Same shape as env-boundary.test.cjs: sandbox the tree (frontend/src and
 * backend/src/index.ts, both of which the check reads) so a probe never
 * touches the real repo or races a concurrent test file, plant a real gap,
 * require the check to name it, then prove the check accepts a fixed tree
 * again. Every probe here is a DATEIKOPIE-style sandbox write, never
 * `git checkout --` against the real tree.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createSandbox, removeSandbox } = require("./test-helpers/sandbox-tree.cjs");

const repoRoot = path.resolve(__dirname, "..");
const real = require("./cors-header-boundary.cjs");

const relFrontendSrc = path.relative(repoRoot, real.FRONTEND_SRC).split(path.sep).join("/");
const relCorsConfig = path.relative(repoRoot, real.CORS_CONFIG_FILE).split(path.sep).join("/");

const root = createSandbox(
  repoRoot,
  [relFrontendSrc, relCorsConfig, "scripts/cors-header-boundary.cjs"],
  "cors-header-boundary-sandbox-",
);
const CHECK = path.join(root, "scripts", "cors-header-boundary.cjs");
const SANDBOX_CORS_CONFIG = path.join(root, relCorsConfig);
const PROBE_FILE = path.join(root, relFrontendSrc, "__cors_probe__.ts");

const run = () => spawnSync("node", [CHECK], { cwd: root, encoding: "utf8" });
const outputOf = (result) => `${result.stdout ?? ""}${result.stderr ?? ""}`;

let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`  ok: ${label}`);
};

try {
  check("clean sandbox tree passes", () => {
    const result = run();
    assert.equal(result.status, 0, outputOf(result));
    assert.match(outputOf(result), /CORS header boundary holds/);
  });

  check("a header the frontend sends but the allowlist omits is rejected", () => {
    fs.writeFileSync(
      PROBE_FILE,
      [
        'import { api } from "./api";',
        "",
        "export const probe = () =>",
        '  api.put("/probe", {}, { headers: { "X-Probe-Header": "1" } });',
        "",
      ].join("\n"),
      "utf8",
    );
    try {
      const result = run();
      const output = outputOf(result);
      assert.equal(result.status, 1, output);
      assert.match(output, /x-probe-header/);
      assert.match(output, /__cors_probe__\.ts/);
    } finally {
      fs.rmSync(PROBE_FILE, { force: true });
    }
  });

  check("this repo's own historical gap (NIL-586) is caught: If-Match missing", () => {
    const before = fs.readFileSync(SANDBOX_CORS_CONFIG, "utf8");
    const withoutIfMatch = before
      .replace(/\n\s*"if-match",/, "")
      .replace(/\n\s*"x-document-edit-token",/, "");
    assert.notEqual(withoutIfMatch, before, "fixture did not actually remove the two headers");
    fs.writeFileSync(SANDBOX_CORS_CONFIG, withoutIfMatch, "utf8");
    try {
      const result = run();
      const output = outputOf(result);
      assert.equal(result.status, 1, output);
      assert.match(output, /if-match/);
      assert.match(output, /x-document-edit-token/);
      assert.match(output, /assets\.ts/);
    } finally {
      fs.writeFileSync(SANDBOX_CORS_CONFIG, before, "utf8");
    }
  });

  check("a header only ever set through a known dynamic variable is resolved, not flagged", () => {
    // frontend/src/api/auth.ts already sends `headers[csrfHeaderName] = ...`
    // for real, resolved via KNOWN_DYNAMIC_HEADER_VARS to "x-csrf-token" --
    // already allowlisted. This just re-confirms the clean tree (which
    // contains that exact call) still passes, i.e. the dynamic-assignment
    // path does not itself produce a false violation.
    const result = run();
    assert.equal(result.status, 0, outputOf(result));
  });

  check("an unmapped dynamic header[var] assignment is flagged, not silently skipped", () => {
    fs.writeFileSync(
      PROBE_FILE,
      [
        "export const probe = (config, someOtherHeaderVar) => {",
        "  config.headers[someOtherHeaderVar] = 'x';",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );
    try {
      const result = run();
      const output = outputOf(result);
      assert.equal(result.status, 1, output);
      assert.match(output, /someOtherHeaderVar/);
      assert.match(output, /KNOWN_DYNAMIC_HEADER_VARS/);
    } finally {
      fs.rmSync(PROBE_FILE, { force: true });
    }
  });

  console.log(`\n${passed} cors-header-boundary counterprobes passed.`);
} finally {
  removeSandbox(root);
}
