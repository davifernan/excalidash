#!/usr/bin/env node
/**
 * Counterprobe for scripts/prisma-client-integrity.cjs (NIL-703).
 *
 * This is the mandatory red-proof for a flake that could not be reliably
 * triggered for real (it depends on CI-runner filesystem timing that never
 * reproduced locally). Simulated, not the real race: this test plants the
 * exact BROKEN STATE the check exists to catch -- a truncated/invalid
 * `package.json` and a zero-byte engine binary -- by direct file copy on
 * the real generated output (never `git checkout --`, and the directory is
 * gitignored/generated in the first place, so there is nothing to check out
 * from), then restores the original bytes afterward. It proves the check
 * fires and names the exact problem; it does not reproduce the original
 * flake's trigger.
 *
 * Requires `npx prisma generate` to have already run in `backend/` (the
 * normal CI order -- this check only makes sense after that step).
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const CHECK = path.join(__dirname, "prisma-client-integrity.cjs");
const { CLIENT_DIR, PACKAGE_JSON } = require("./prisma-client-integrity.cjs");

const run = () => spawnSync("node", [CHECK], { encoding: "utf8" });

// "Delivery Contract Tests" runs every scripts/*.test.cjs by glob, including
// this one, in a job that never installs backend/ or runs `prisma generate`
// -- there is genuinely no generated client to probe against there. That is
// a missing precondition for THIS counterprobe, not a failure of the check
// it probes: exit 0 with a clear line, not 1, so `node --test`'s glob does
// not read an inapplicable environment as a red result.
if (!fs.existsSync(CLIENT_DIR)) {
  console.log(
    `SKIPPED: ${path.relative(process.cwd(), CLIENT_DIR)} does not exist in this job (no ` +
      `"prisma generate" step ran here) -- nothing to probe. Run "npx prisma generate" in ` +
      `backend/ first to exercise this counterprobe for real.`,
  );
  process.exit(0);
}

let failures = 0;

const withBackup = (filePath, mutate, label) => {
  const original = fs.readFileSync(filePath);
  try {
    mutate();
    const result = run();
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    if (result.status === 1 && output.includes("PRISMA CLIENT INCOMPLETE")) {
      console.log(`  red on ${label}: exit 1, message present`);
    } else {
      failures++;
      console.error(`  FAILED to catch ${label}: exit=${result.status}\n${output}`);
    }
  } finally {
    fs.writeFileSync(filePath, original);
  }
};

// Probe 1: the exact real-world symptom -- an empty package.json.
withBackup(
  PACKAGE_JSON,
  () => fs.writeFileSync(PACKAGE_JSON, ""),
  "empty package.json (the 'File is empty' incident)",
);

// Probe 2: the other real-world symptom -- present but not valid JSON.
withBackup(
  PACKAGE_JSON,
  () => fs.writeFileSync(PACKAGE_JSON, '{"name": "generated-client", "main": '),
  "truncated/invalid-JSON package.json (the 'Invalid package config' incident)",
);

// Probe 3: not in either real incident, but named in NIL-703's own
// instruction ("die generierte package.json UND die Engine-Binaries") -- a
// zero-byte engine binary should be caught the same way a half-written
// package.json is.
const engineFile = fs
  .readdirSync(CLIENT_DIR)
  .find((name) => require("./prisma-client-integrity.cjs").ENGINE_BINARY_PATTERN.test(name));
if (engineFile) {
  withBackup(
    path.join(CLIENT_DIR, engineFile),
    () => fs.writeFileSync(path.join(CLIENT_DIR, engineFile), ""),
    `zero-byte engine binary (${engineFile})`,
  );
} else {
  failures++;
  console.error("  FAILED: no engine binary found to probe against -- run prisma generate first.");
}

// Confirm the check is genuinely clean again after every probe restored its
// own file -- otherwise a probe that "passed" by leaving the tree broken
// would look identical to one that passed cleanly.
const finalResult = run();
if (finalResult.status === 0) {
  console.log("  green again after all probes restored their files");
} else {
  failures++;
  console.error(
    `  FAILED: check is not green after restoring -- a probe leaked a mutation:\n${finalResult.stdout}${finalResult.stderr}`,
  );
}

if (failures > 0) {
  console.error(`\n${failures} probe(s) failed to be caught correctly.`);
  process.exit(1);
}
console.log("\nAll probes caught correctly, check is clean afterward.");
process.exit(0);
