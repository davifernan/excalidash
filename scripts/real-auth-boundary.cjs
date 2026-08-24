#!/usr/bin/env node
/**
 * Guard for e2e/playwright.config.ts's REAL_AUTH_SPECS.
 *
 * toggleAuthEnabled (e2e/tests/helpers/authLifecycle.ts) flips a real,
 * backend-wide switch -- not scoped to the calling spec's own session. A
 * spec that imports it but is missing from REAL_AUTH_SPECS keeps running
 * inside the shared `chromium` project's shards, and poisons every spec
 * sharing its shard the moment it runs. This happened twice with the list
 * hand-maintained: comments-two-account.spec.ts (NIL-356) first, then
 * discovery-permission-matrix.spec.ts (NIL-326) -- each caught only after
 * dozens of unrelated specs went red with "401 Authentication token
 * required", not when the spec was written.
 *
 * This check makes the list's completeness derived instead of remembered:
 * every spec that imports `toggleAuthEnabled` from `helpers/authLifecycle`
 * must be reachable from REAL_AUTH_SPECS. Checked against the *import*, not
 * the call-site identifier -- `import { toggleAuthEnabled as flipAuth }`
 * still calls the same real, backend-wide switch, and a check keyed on the
 * bare identifier would miss it.
 */

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const E2E_TESTS_DIR = path.join(root, "e2e", "tests");
const CONFIG_FILE = path.join(root, "e2e", "playwright.config.ts");
const HELPER_FILE = "helpers/authLifecycle";
const TOGGLE_NAME = "toggleAuthEnabled";

/** Every `const NAME = [ ...contents... ];` block, name -> raw array contents. */
const parseArrayConsts = (source) => {
  const consts = new Map();
  const re = /const\s+(\w+)\s*=\s*\[([\s\S]*?)\];/g;
  let match;
  while ((match = re.exec(source))) {
    consts.set(match[1], match[2]);
  }
  return consts;
};

/** String-literal glob entries directly present in a `[...]` body. */
const literalGlobs = (body) => [...body.matchAll(/["'`](\*\*\/[^"'`]+\.spec\.ts)["'`]/g)].map(
  (m) => m[1],
);

/** Names spread into a `[...]` body via `...NAME`. */
const spreadRefs = (body) => [...body.matchAll(/\.\.\.(\w+)/g)].map((m) => m[1]);

/**
 * Resolve REAL_AUTH_SPECS (or any named array const) to the full set of
 * `.spec.ts` globs it covers, following `...NAME` spreads to whatever depth
 * the config actually uses. A name that does not resolve to a known const is
 * an error, not a silent skip -- a typo'd spread must not read as "covers
 * nothing" the same way a missing entry does.
 */
const resolveGlobs = (consts, name, seen = new Set()) => {
  if (seen.has(name)) return [];
  seen.add(name);
  const body = consts.get(name);
  if (body === undefined) {
    throw new Error(`playwright.config.ts: '${name}' is referenced but never defined as a const`);
  }
  const direct = literalGlobs(body);
  const nested = spreadRefs(body).flatMap((ref) => resolveGlobs(consts, ref, seen));
  return [...direct, ...nested];
};

// A "**/" prefix glob resolves to a bare basename. This repo's globs are always this shape.
const globToBasename = (glob) => glob.replace(/^\*\*\//, "");

/**
 * Does this spec file's source import `toggleAuthEnabled` (under any local
 * name) from `helpers/authLifecycle`? Matches the whole `import { ... }
 * from "..."` statement rather than grepping for the bare identifier, so a
 * comment mentioning the helper (this repo has several) is not mistaken for
 * an import, and an aliased import is not missed.
 */
const importsToggle = (source) => {
  const importRe =
    /import\s*\{([\s\S]*?)\}\s*from\s*["'][^"']*helpers\/authLifecycle["']/g;
  let match;
  while ((match = importRe.exec(source))) {
    const names = match[1]
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => entry.split(/\s+as\s+/)[0].trim());
    if (names.includes(TOGGLE_NAME)) return true;
  }
  return false;
};

const main = () => {
  if (!fs.existsSync(CONFIG_FILE)) {
    console.error(`No playwright config at ${CONFIG_FILE}`);
    process.exit(2);
  }
  const configSource = fs.readFileSync(CONFIG_FILE, "utf8");
  const consts = parseArrayConsts(configSource);
  const coveredBasenames = new Set(resolveGlobs(consts, "REAL_AUTH_SPECS").map(globToBasename));

  const specFiles = fs
    .readdirSync(E2E_TESTS_DIR)
    .filter((name) => name.endsWith(".spec.ts"));

  const uncovered = [];
  for (const name of specFiles) {
    const source = fs.readFileSync(path.join(E2E_TESTS_DIR, name), "utf8");
    if (importsToggle(source) && !coveredBasenames.has(name)) {
      uncovered.push(name);
    }
  }

  if (uncovered.length === 0) {
    console.log(
      `Real-auth boundary holds. ${specFiles.length} specs checked, ${coveredBasenames.size} real-auth specs registered.`,
    );
    process.exit(0);
  }

  for (const name of uncovered) {
    console.error(
      `VIOLATION  ${name}: imports toggleAuthEnabled from helpers/authLifecycle but is not ` +
        `reachable from REAL_AUTH_SPECS in e2e/playwright.config.ts -- it will run inside the ` +
        `shared chromium project's shards and flip real auth on for whatever backend they use.`,
    );
  }
  process.exit(1);
};

module.exports = { parseArrayConsts, resolveGlobs, globToBasename, importsToggle };

if (require.main === module) main();
