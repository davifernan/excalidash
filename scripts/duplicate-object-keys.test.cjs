#!/usr/bin/env node
/**
 * Counterprobe for scripts/duplicate-object-keys.cjs (NIL-636).
 *
 * The two real incidents this check exists for -- `frontend/vite.config.ts`'s
 * duplicate `resolve:` key and `frontend/knip.json`'s duplicate
 * `ignoreDependencies` key -- are both reproduced as probes below, planted
 * in a private temp file (never the real repo tree), asserting the check
 * names the exact duplicated key. The negative probes matter as much: a
 * scanner that flags a ternary's `cond ? a : b`, a nested nested nested
 * unrelated key, or an unrelated array/YAML shape would cry wolf on correct
 * config and train people to ignore it.
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  findDuplicateObjectKeys,
  findDuplicateYamlTopLevelKeys,
  checkFile,
} = require("./duplicate-object-keys.cjs");

test("catches the real vite.config.ts duplicate resolve: key", () => {
  const src = `
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@excalidash/domain": path.resolve(__dirname, "../packages/domain/src") },
  },
  resolve: {
    alias: { "decode-named-character-reference": "x" },
  },
});
`;
  const findings = findDuplicateObjectKeys(src);
  const keys = findings.map((f) => f.key);
  assert.ok(keys.includes("resolve"), `expected "resolve" among duplicates, got ${keys}`);
});

test("catches the real knip.json duplicate ignoreDependencies key", () => {
  const src = `{
  "$schema": "https://unpkg.com/knip@5/schema.json",
  "entry": ["src/**/*.{test,spec}.{ts,tsx}"],
  "ignoreDependencies": ["decode-named-character-reference"],
  "ignore": ["public/runtime-config.js"],
  "ignoreDependencies": ["@excalidash/domain", "eslint", "happy-dom", "prettier"],
  "project": ["**/*.{js,jsx,ts,tsx,mjs,cjs,css}"]
}`;
  const findings = findDuplicateObjectKeys(src);
  const keys = findings.map((f) => f.key);
  assert.ok(
    keys.includes("ignoreDependencies"),
    `expected "ignoreDependencies" among duplicates, got ${keys}`,
  );
});

test("does not flag a clean, deduplicated object", () => {
  const src = `{
  "entry": ["a"],
  "ignoreDependencies": ["a", "b"],
  "ignore": ["c"]
}`;
  assert.deepEqual(findDuplicateObjectKeys(src), []);
});

test("does not mistake a ternary for an object key", () => {
  const src = `
export default {
  foo: cond ? a : b,
  bar: 1,
};
`;
  assert.deepEqual(findDuplicateObjectKeys(src), []);
});

test("does not flag the same key name at two different nesting levels", () => {
  const src = `{
  "name": "outer",
  "nested": { "name": "inner" }
}`;
  assert.deepEqual(findDuplicateObjectKeys(src), []);
});

test("flags a duplicate key nested inside a value, scoped to that literal only", () => {
  const src = `{
  "outer": {
    "a": 1,
    "a": 2
  },
  "sibling": { "a": 1 }
}`;
  const findings = findDuplicateObjectKeys(src);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].key, "a");
});

test("YAML: flags a duplicate top-level key (e.g. two `on:` blocks)", () => {
  const src = [
    "name: CI",
    "on:",
    "  push:",
    "    branches: [main]",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "on:",
    "  pull_request: {}",
    "",
  ].join("\n");
  const findings = findDuplicateYamlTopLevelKeys(src);
  const keys = findings.map((f) => f.key);
  assert.ok(keys.includes("on"), `expected "on" among duplicates, got ${keys}`);
});

test("YAML: does not flag an indented (non-top-level) repeated key", () => {
  const src = [
    "jobs:",
    "  build:",
    "    steps:",
    "      - run: echo a",
    "      - run: echo b",
    "",
  ].join("\n");
  assert.deepEqual(findDuplicateYamlTopLevelKeys(src), []);
});

test("end-to-end: checkFile reports line numbers for a planted duplicate", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duplicate-object-keys-probe-"));
  const filePath = path.join(dir, "knip.json");
  try {
    fs.writeFileSync(
      filePath,
      `{\n  "ignoreDependencies": ["a"],\n  "ignore": [],\n  "ignoreDependencies": ["b"]\n}\n`,
    );
    const findings = checkFile(filePath);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].key, "ignoreDependencies");
    assert.deepEqual(findings[0].lines, [2, 4]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
