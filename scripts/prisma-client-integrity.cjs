#!/usr/bin/env node
/**
 * Verifies that `npx prisma generate` actually produced a usable client
 * before the next CI step (`npm test`) relies on it (NIL-703).
 *
 * Why this exists: `backend-tests` measurably crashed twice with no failed
 * assertion at all -- Vitest aborted an entire test FILE at import time with
 * a Node module-resolution error reading
 * `backend/src/generated/client/package.json` ("Invalid package config" once,
 * "File is empty" once, on two unrelated commits, hitting two different test
 * files). Both times the person reading the log had to scroll past 1300+
 * passing tests to find a "Failed Suites 1" block that named a completely
 * unrelated file, with nothing pointing at the actual cause. This check runs
 * once, right after the "Generate Prisma client" step, and fails in one line
 * if the client is not actually usable -- so the NEXT occurrence is obvious
 * immediately instead of costing another twenty minutes in test logs where
 * no test failed.
 *
 * Deliberately not a retry around `prisma generate`: a retry makes the flake
 * rarer and the eventual recurrence harder to diagnose, since nobody would
 * see it happen. This only reports; it never re-runs generate itself.
 *
 * What "usable" means, checked in order:
 *   1. The output directory exists at all.
 *   2. `package.json` exists and is parseable JSON (the exact failure mode
 *      both real incidents hit).
 *   3. At least one native query-engine binary exists inside it, and every
 *      engine binary present is non-empty (catches a half-copied binary,
 *      not just a half-written package.json -- the mechanism suspected for
 *      the package.json failures, if real, would not spare the binaries).
 */

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const CLIENT_DIR = path.join(root, "backend", "src", "generated", "client");
const PACKAGE_JSON = path.join(CLIENT_DIR, "package.json");

// Query engine binaries are named `libquery_engine-<target>.<ext>.node` on
// Linux/macOS and `query_engine-<target>.dll.node` on Windows. CI only ever
// runs this on Linux (`ubuntu-latest`), but the pattern is written to not
// assume that -- it matches either prefix, any target, any native-addon
// suffix, rather than hardcoding today's three `binaryTargets` from
// `backend/prisma/schema.prisma`. Hardcoding those would silently stop
// checking anything the day someone edits that list.
const ENGINE_BINARY_PATTERN = /^(?:lib)?query_engine[-.].+\.node$/;

function main() {
  const violations = [];

  if (!fs.existsSync(CLIENT_DIR) || !fs.statSync(CLIENT_DIR).isDirectory()) {
    console.error(
      `PRISMA CLIENT INCOMPLETE  ${path.relative(root, CLIENT_DIR)} does not exist. ` +
        `"Generate Prisma client" did not produce an output directory at all -- check that step's own log, not the test log.`,
    );
    process.exit(1);
  }

  if (!fs.existsSync(PACKAGE_JSON)) {
    violations.push(`${path.relative(root, PACKAGE_JSON)} is missing.`);
  } else {
    const raw = fs.readFileSync(PACKAGE_JSON, "utf8");
    if (raw.trim().length === 0) {
      violations.push(`${path.relative(root, PACKAGE_JSON)} is empty (0 usable bytes).`);
    } else {
      try {
        JSON.parse(raw);
      } catch (error) {
        violations.push(`${path.relative(root, PACKAGE_JSON)} is not valid JSON: ${error.message}`);
      }
    }
  }

  const entries = fs.readdirSync(CLIENT_DIR);
  const engineFiles = entries.filter((name) => ENGINE_BINARY_PATTERN.test(name));
  if (engineFiles.length === 0) {
    violations.push(
      `no query-engine binary found in ${path.relative(root, CLIENT_DIR)} (expected a file matching ${ENGINE_BINARY_PATTERN}).`,
    );
  } else {
    for (const name of engineFiles) {
      const size = fs.statSync(path.join(CLIENT_DIR, name)).size;
      if (size === 0) {
        violations.push(`${name} is 0 bytes -- copied incompletely.`);
      }
    }
  }

  if (violations.length === 0) {
    console.log(
      `Prisma client is usable. ${path.relative(root, PACKAGE_JSON)} parses, ` +
        `${engineFiles.length} query-engine binar${engineFiles.length === 1 ? "y" : "ies"} present and non-empty.`,
    );
    process.exit(0);
  }

  console.error(
    'PRISMA CLIENT INCOMPLETE -- "Generate Prisma client" did not finish producing a usable ' +
      "client (NIL-703). This is the CI step to look at, not whichever test happened to import it first:",
  );
  for (const line of violations) console.error(`  - ${line}`);
  process.exit(1);
}

module.exports = { CLIENT_DIR, PACKAGE_JSON, ENGINE_BINARY_PATTERN };

if (require.main === module) {
  main();
}
