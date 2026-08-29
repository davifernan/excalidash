"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { archiveRootFor } = require("./soak-upload-artifact-root.cjs");

/**
 * NIL-639 Hans finding on #223: "Upload DB/asset state for the next part"
 * uploads backend/prisma/nightly-soak.db(-wal/-shm) alongside
 * backend/prisma/nightly-soak-assets/** in one upload-artifact@v4 call.
 * Their common ancestor is backend/prisma, so the archive preserves the
 * assets directory under ITS OWN name, nightly-soak-assets/ -- never under
 * a plain "assets/". "Restore prior part's DB/asset state" checked for
 * /tmp/soak-db-state/assets, which never existed. Because `rm -rf
 * "${ASSET_STORAGE_DIR}"` runs unconditionally just before that check,
 * every part after the first silently restored an EMPTY asset store: no
 * error, no warning, just a board that looks like it lost every
 * previously-uploaded image from part 2 onward. This is the exact same
 * upload-artifact root rule as Hans's earlier part-summary.json finding
 * (soak-artifact-layout.test.cjs), just on the OTHER artifact this workflow
 * carries between parts.
 *
 * This does not assert "the directory name looks right" -- it re-derives,
 * from the upload step's own configured `path:`, what upload-artifact
 * actually names the assets directory inside the archive, and checks that
 * against the literal directory name the restore step's shell script
 * checks for. Reverting the restore-step fix (checking `assets` again
 * instead of `nightly-soak-assets`) turns this test red without touching
 * this file.
 */

const WORKFLOW_PATH = path.join(__dirname, "..", ".github", "workflows", "_soak-part.yml");
const UPLOAD_STEP_NAME = "Upload DB/asset state for the next part";
const RESTORE_STEP_NAME = "Restore prior part's DB/asset state";
const WORKSPACE = "/gh-workspace";

// The upload step's actual local source for the assets dir, matching
// $ASSET_STORAGE_DIR's value set at the top of _soak-part.yml
// (backend/prisma/nightly-soak-assets) -- kept as a literal here rather
// than parsed out of the env: block, since that block's shape isn't the
// thing this finding is about.
const ASSET_STORAGE_DIR_RELATIVE = "backend/prisma/nightly-soak-assets";

// Extracts the literal directory name the restore step's shell script
// checks with `[ -d /tmp/soak-db-state/<name> ]` and copies from with
// `cp -a /tmp/soak-db-state/<name>/. ...`. Both must reference the same
// name, and that name is asserted against the upload step's real archive
// layout below -- not just against each other, since two consistently
// WRONG names would still pass a same-file comparison.
function extractRestoreDirName(workflowSource) {
  const lines = workflowSource.split(/\r?\n/);
  const stepStart = lines.findIndex((l) => l.trim() === `- name: ${RESTORE_STEP_NAME}`);
  assert.notStrictEqual(stepStart, -1, `step "${RESTORE_STEP_NAME}" not found`);
  let stepEnd = lines.length;
  for (let i = stepStart + 1; i < lines.length; i++) {
    if (/^ {6}- name:/.test(lines[i])) {
      stepEnd = i;
      break;
    }
  }
  const block = lines.slice(stepStart, stepEnd).join("\n");
  const match = block.match(/\[ -d \/tmp\/soak-db-state\/(\S+) \]/);
  assert.ok(match, `no "[ -d /tmp/soak-db-state/<name> ]" check found in "${RESTORE_STEP_NAME}"`);
  return match[1];
}

test("the restore step checks the directory name upload-artifact actually produces for the assets carryover", () => {
  const workflowSource = fs.readFileSync(WORKFLOW_PATH, "utf8");

  const archiveRoot = archiveRootFor(WORKFLOW_PATH, UPLOAD_STEP_NAME, WORKSPACE);
  const assetsAbsolute = path.posix.join(WORKSPACE, ASSET_STORAGE_DIR_RELATIVE);
  const assetsNameInArchive = path.posix.relative(archiveRoot, assetsAbsolute);

  const restoreDirName = extractRestoreDirName(workflowSource);

  assert.strictEqual(
    restoreDirName,
    assetsNameInArchive,
    `upload-artifact would name the assets directory "${assetsNameInArchive}" inside the ` +
      `"${UPLOAD_STEP_NAME}" archive, but "${RESTORE_STEP_NAME}" checks for ` +
      `"/tmp/soak-db-state/${restoreDirName}". A mismatch means every part after the first ` +
      `restores an EMPTY asset store, silently -- rm -rf already cleared the local one first.`,
  );
});

test("the restored directory name is not the literal (and wrong) 'assets'", () => {
  // A same-file self-consistency check would still pass if both sides had
  // been "fixed" to agree on the wrong literal -- this pins the specific
  // historical bug (checking "assets" when upload-artifact never produces
  // that name here) so a regression back to it is caught even if someone
  // "fixes" both sides in lockstep by mistake.
  const workflowSource = fs.readFileSync(WORKFLOW_PATH, "utf8");
  const restoreDirName = extractRestoreDirName(workflowSource);
  assert.notStrictEqual(restoreDirName, "assets");
  assert.strictEqual(restoreDirName, "nightly-soak-assets");
});
