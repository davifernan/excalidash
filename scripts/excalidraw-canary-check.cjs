#!/usr/bin/env node
/**
 * Installs a genuinely different @excalidraw/excalidraw version and asks
 * whether our adapter still holds against it -- the "Canary-Lauf" NIL-322's
 * closing review found missing (NIL-340): `verifySeams()`
 * (frontend/src/integrations/excalidraw/compatibility/seams.ts) existed and
 * was unit-tested, but had never run against a package actually installed at
 * a different version. This is that run, made repeatable.
 *
 * A canary proves "an OTHER version doesn't break us", not specifically "the
 * NEXT version doesn't break us" -- the direction is secondary to the
 * property. Default target is npm's current `latest` dist-tag (the forward
 * check, once upstream publishes past our pin); pass an explicit version or
 * dist-tag to check any other one (including backward, e.g. `0.18.0`, which
 * is how this script itself was verified against a real, differing install).
 *
 * Usage:
 *   node scripts/excalidraw-canary-check.cjs [version-or-dist-tag]
 *
 * Exit 0: nothing to check (target === pinned) or the canary holds.
 * Exit 1: the canary found a real seam break, or the run itself failed.
 *
 * Always restores the pinned install afterward (via `npm ci`), success or
 * failure, so this never leaves the workspace on a swapped version.
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.join(__dirname, "..");
const FRONTEND_DIR = path.join(REPO_ROOT, "frontend");
const SEAM_TEST_FILES = [
  "src/integrations/excalidraw/compatibility/seams.test.ts",
  "src/integrations/excalidraw/compatibility/seams.integration.test.tsx",
  "src/integrations/excalidraw/index.test.ts",
];

/**
 * The one assertion that is SUPPOSED to fail whenever target !== pinned: it
 * hardcodes the pinned version string to catch `packageVersion()` silently
 * returning a wrong constant. That is a real, separate regression check --
 * not the seam question this script asks -- so it is the one named
 * exemption, not a blanket "ignore any one failure".
 */
const EXPECTED_FAILURE_TITLE = "reports the version it is running against";

const pinnedVersion = () =>
  JSON.parse(fs.readFileSync(path.join(FRONTEND_DIR, "package.json"), "utf8")).dependencies[
    "@excalidraw/excalidraw"
  ];

/** No npm CLI subprocess for this -- the registry's own HTTP API needs no auth. */
const resolveLatestFromRegistry = () =>
  new Promise((resolve, reject) => {
    https
      .get(
        "https://registry.npmjs.org/@excalidraw/excalidraw",
        { headers: { Accept: "application/vnd.npm.install-v1+json" } },
        (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`registry lookup failed: HTTP ${res.statusCode}`));
            res.resume();
            return;
          }
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => {
            try {
              resolve(JSON.parse(body)["dist-tags"].latest);
            } catch (err) {
              reject(err);
            }
          });
        },
      )
      .on("error", reject);
  });

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, stdio: "inherit", env: process.env });

/**
 * Runs the seam suite with vitest's JSON reporter and returns the list of
 * failed assertion titles, minus the one expected exemption above. An empty
 * list means the canary holds, regardless of vitest's own exit code.
 */
const runSeamSuite = (cwd) => {
  const outputFile = path.join(os.tmpdir(), `excalidraw-canary-${process.pid}.json`);
  try {
    try {
      execFileSync(
        "npx",
        ["vitest", "run", "--reporter=json", `--outputFile=${outputFile}`, ...SEAM_TEST_FILES],
        { cwd, stdio: ["ignore", "ignore", "inherit"], env: process.env },
      );
    } catch {
      // vitest exits non-zero on any test failure; the JSON file is still written.
    }
    const report = JSON.parse(fs.readFileSync(outputFile, "utf8"));
    const failed = report.testResults
      .flatMap((suite) => suite.assertionResults)
      .filter((a) => a.status === "failed")
      .map((a) => a.title);
    return failed.filter((title) => title !== EXPECTED_FAILURE_TITLE);
  } finally {
    fs.rmSync(outputFile, { force: true });
  }
};

async function main() {
  const pinned = pinnedVersion();
  const requested = process.argv[2];
  const target = requested || (await resolveLatestFromRegistry());

  console.log(`Pinned version:  ${pinned}`);
  console.log(`Canary target:   ${target}${requested ? "" : " (npm 'latest', resolved just now)"}`);

  if (target === pinned) {
    console.log("Canary target is the pinned version -- nothing to check.");
    process.exit(0);
  }

  let realFailures;
  try {
    console.log(
      `\nInstalling @excalidraw/excalidraw@${target} (no lockfile/package.json change)...`,
    );
    run("npm", ["install", `@excalidraw/excalidraw@${target}`, "--no-save"], FRONTEND_DIR);

    console.log(`\nRunning the seam suite against the installed ${target}...`);
    realFailures = runSeamSuite(FRONTEND_DIR);
  } finally {
    console.log("\nRestoring the pinned install from the lockfile...");
    run("npm", ["ci", "--no-audit", "--no-fund"], FRONTEND_DIR);
  }

  if (realFailures.length === 0) {
    console.log(
      `\nCanary holds: @excalidraw/excalidraw@${target} breaks no seam this application depends on.\n` +
        `("${EXPECTED_FAILURE_TITLE}" may have failed above -- that's the hardcoded pinned-\n` +
        "version assertion noticing the swap, not a seam break, and is excluded from this result.)",
    );
    process.exit(0);
  }

  console.error(
    `\nCanary found ${realFailures.length} real seam break(s) against @excalidraw/excalidraw@${target}:`,
  );
  for (const title of realFailures) console.error(`  - ${title}`);
  console.error(
    "\nSee docs/architecture/EXCALIDRAW_ADAPTER.md for what to do about a missing export,\n" +
      "API method, or DOM selector before adopting this version.",
  );
  process.exit(1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { pinnedVersion, resolveLatestFromRegistry };
