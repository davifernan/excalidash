#!/usr/bin/env node
/**
 * Finds duplicate keys in object literals (JSON/JS/TS) and duplicate
 * top-level mapping keys in YAML files (NIL-636).
 *
 * git's line-based merge sees two non-overlapping hunks that each add a
 * distinct `key: value` pair as non-conflicting, even when both add the
 * SAME key at the same nesting level -- the merge succeeds silently and the
 * file ends up with the key twice. `tsc` flags a literal duplicate object
 * key as TS1117, but esbuild (what Vite's dev server and build actually
 * run) only warns and lets the last one win at runtime; plain JSON.parse
 * and YAML parsers do the same. Two instances of exactly this landed in
 * this PR from two separate merges: `frontend/vite.config.ts`'s duplicate
 * `resolve:` key and `frontend/knip.json`'s duplicate `ignoreDependencies`
 * key. Neither tsc, ESLint, nor a JSON schema check caught either one.
 *
 * This is a best-effort brace/indentation scanner, not a real parser:
 *   - JS/TS/JSON: tracks every object literal via `{ ... }` nesting and
 *     flags a key repeated within the SAME literal, at any depth. Template
 *     literals are skipped opaquely (a `${...}` containing braces is not
 *     tracked); regex literals are not recognized, so a config file
 *     containing one could misparse. Config files (package.json, knip.json,
 *     tsconfig.json, vite/vitest config) are simple enough that this holds
 *     in practice; do not point it at arbitrary application source.
 *   - YAML: flags a duplicate key only at column 0 (the file's own
 *     top-level mapping, e.g. two `on:` blocks in a workflow) -- exactly
 *     the shape this bug class takes in a workflow file. It does not
 *     understand YAML anchors, flow style, or nested duplicates.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const KEY_START = /[A-Za-z_$]/;
const KEY_CONT = /[A-Za-z0-9_$]/;

function findDuplicateObjectKeys(text) {
  const findings = [];
  const stack = [];
  let line = 1;
  let i = 0;
  const n = text.length;

  const recordKey = (key, keyLine) => {
    const frame = stack[stack.length - 1];
    if (!frame.keys.has(key)) frame.keys.set(key, []);
    frame.keys.get(key).push(keyLine);
  };

  const skipQuoted = (quote) => {
    i++;
    while (i < n) {
      if (text[i] === "\\") {
        i += 2;
        continue;
      }
      if (text[i] === "\n") line++;
      if (text[i] === quote) {
        i++;
        return;
      }
      i++;
    }
  };

  while (i < n) {
    const c = text[i];
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] === "\n") line++;
        i++;
      }
      i += 2;
      continue;
    }
    if (c === "`") {
      i++;
      while (i < n && text[i] !== "`") {
        if (text[i] === "\\") i++;
        if (text[i] === "\n") line++;
        i++;
      }
      i++;
      continue;
    }
    const top = stack[stack.length - 1];
    const atKeyPosition = top && top.type === "{" && top.expectKey;
    if ((c === '"' || c === "'") && atKeyPosition) {
      const quote = c;
      const startLine = line;
      const startI = i;
      i++;
      let key = "";
      while (i < n) {
        if (text[i] === "\\") {
          key += text[i] + text[i + 1];
          i += 2;
          continue;
        }
        if (text[i] === "\n") line++;
        if (text[i] === quote) {
          i++;
          break;
        }
        key += text[i];
        i++;
      }
      let j = i;
      while (j < n && /\s/.test(text[j])) j++;
      if (text[j] === ":") {
        recordKey(key, startLine);
        top.expectKey = false;
        i = j + 1;
      } else {
        i = startI + 1;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      skipQuoted(c);
      continue;
    }
    if (c === "{") {
      stack.push({ type: "{", keys: new Map(), expectKey: true, line });
      i++;
      continue;
    }
    if (c === "[") {
      stack.push({ type: "[" });
      i++;
      continue;
    }
    if (c === "(") {
      stack.push({ type: "(" });
      i++;
      continue;
    }
    if (c === "}") {
      const frame = stack.pop();
      if (frame && frame.type === "{") {
        for (const [key, lines] of frame.keys) {
          if (lines.length > 1) findings.push({ key, lines });
        }
      }
      i++;
      continue;
    }
    if (c === "]" || c === ")") {
      stack.pop();
      i++;
      continue;
    }
    if (c === ",") {
      if (top && top.type === "{") top.expectKey = true;
      i++;
      continue;
    }
    if (KEY_START.test(c) && atKeyPosition) {
      let j = i;
      while (j < n && KEY_CONT.test(text[j])) j++;
      let k = j;
      while (k < n && /\s/.test(text[k])) k++;
      if (text[k] === ":" && text[k + 1] !== ":") {
        recordKey(text.slice(i, j), line);
        top.expectKey = false;
        i = k + 1;
        continue;
      }
      i = j;
      continue;
    }
    i++;
  }

  return findings;
}

function findDuplicateYamlTopLevelKeys(text) {
  const seen = new Map();
  const lines = text.split("\n");
  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx];
    if (/^\s/.test(raw) || raw.trim() === "" || raw.trimStart().startsWith("#")) continue;
    const m = raw.match(/^([A-Za-z0-9_.\-]+|"[^"]+"|'[^']+')\s*:(\s|$)/);
    if (!m) continue;
    const key = m[1].replace(/^["']|["']$/g, "");
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(idx + 1);
  }
  const findings = [];
  for (const [key, lineNumbers] of seen) {
    if (lineNumbers.length > 1) findings.push({ key, lines: lineNumbers });
  }
  return findings;
}

function checkFile(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const ext = path.extname(filePath);
  const findings = ext === ".yml" || ext === ".yaml"
    ? findDuplicateYamlTopLevelKeys(text)
    : findDuplicateObjectKeys(text);
  return findings.map((f) => ({ file: filePath, ...f }));
}

const DEFAULT_TARGETS = [
  "package.json",
  "backend/package.json",
  "frontend/package.json",
  "packages/domain/package.json",
  "e2e/package.json",
  "tsconfig.json",
  "backend/tsconfig.json",
  "frontend/tsconfig.json",
  "frontend/tsconfig.node.json",
  "e2e/tsconfig.json",
  "backend/knip.json",
  "frontend/knip.json",
  "frontend/vite.config.ts",
  "frontend/vitest.config.ts",
];

function collectDefaultTargets(repoRoot) {
  const targets = DEFAULT_TARGETS.map((rel) => path.join(repoRoot, rel)).filter((p) =>
    fs.existsSync(p),
  );
  const workflowsDir = path.join(repoRoot, ".github", "workflows");
  if (fs.existsSync(workflowsDir)) {
    for (const entry of fs.readdirSync(workflowsDir)) {
      if (entry.endsWith(".yml") || entry.endsWith(".yaml")) {
        targets.push(path.join(workflowsDir, entry));
      }
    }
  }
  return targets;
}

function main() {
  const repoRoot = path.resolve(__dirname, "..");
  const args = process.argv.slice(2);
  const targets = args.length > 0
    ? args.map((a) => path.resolve(a))
    : collectDefaultTargets(repoRoot);

  let anyFindings = false;
  for (const target of targets) {
    const findings = checkFile(target);
    for (const finding of findings) {
      anyFindings = true;
      const rel = path.relative(repoRoot, finding.file);
      console.error(
        `DUPLICATE KEY  ${rel}: "${finding.key}" declared ${finding.lines.length} times (lines ${finding.lines.join(", ")})`,
      );
    }
  }

  if (anyFindings) {
    process.exit(1);
  }
  console.log(`No duplicate keys found across ${targets.length} file(s).`);
  process.exit(0);
}

module.exports = { findDuplicateObjectKeys, findDuplicateYamlTopLevelKeys, checkFile };

if (require.main === module) main();
