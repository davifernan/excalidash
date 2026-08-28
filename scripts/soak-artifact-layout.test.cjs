"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { ARTIFACT_DIR_RELATIVE, PART_SUMMARY_FILENAME } = require("./soak-nightly-extract.cjs");
const { PART_SUMMARY_RELATIVE_PATH } = require("./soak-nightly-aggregate.cjs");
const {
  commonAncestorSegments,
  resolveToAbsolute,
  extractStepPaths,
} = require("./soak-upload-artifact-root.cjs");

/**
 * NIL-639 Hans finding #2: _soak-part.yml once uploaded a workspace-relative
 * dir (e2e/soak-artifacts/) and an absolute /tmp log path in the SAME
 * upload-artifact@v4 call. Per that action's own docs, multiple paths root
 * the archive at their least common ancestor -- for one relative and one
 * absolute path that ancestor is "/" (filesystem root), not "e2e/". Every
 * night, readPartSummary in soak-nightly-aggregate.cjs looked for
 * part-summary.json where it never existed, all four parts reported
 * "missing", allPassed was reported false, and no CI step ever went red
 * (if-no-files-found: warn). This test does not assert "the path string
 * looks right" -- it re-derives, from the workflow file's OWN configured
 * `path:` and from the extractor's OWN write location, where
 * upload-artifact would actually place part-summary.json inside the
 * archive, and checks that against what soak-nightly-aggregate.cjs actually
 * reads. Reverting the fix in _soak-part.yml (see git history on this file
 * for the two-path version) turns this test red without touching this file.
 */

const WORKFLOW_PATH = path.join(__dirname, "..", ".github", "workflows", "_soak-part.yml");
const STEP_NAME = "Upload this part's soak artifacts";

test("soak-part.yml's upload path resolves to where the aggregator reads part-summary.json", () => {
  const workflowSource = fs.readFileSync(WORKFLOW_PATH, "utf8");
  const configuredPaths = extractStepPaths(workflowSource, STEP_NAME, WORKFLOW_PATH);

  const WORKSPACE = "/gh-workspace";
  const absolutePaths = configuredPaths.map((p) => resolveToAbsolute(p, WORKSPACE));
  const archiveRootSegments = commonAncestorSegments(absolutePaths);
  const archiveRoot = archiveRootSegments.join("/") || "/";

  const partSummaryAbsolute = path.posix.join(
    WORKSPACE,
    ARTIFACT_DIR_RELATIVE.split(path.sep).join("/"),
    PART_SUMMARY_FILENAME,
  );

  const relativeInsideArchive = path.posix.relative(archiveRoot, partSummaryAbsolute);

  assert.strictEqual(
    relativeInsideArchive,
    PART_SUMMARY_RELATIVE_PATH,
    `upload-artifact would place part-summary.json at "${relativeInsideArchive}" inside the ` +
      `"${STEP_NAME}" archive, but soak-nightly-aggregate.cjs's readPartSummary looks for it at ` +
      `"${PART_SUMMARY_RELATIVE_PATH}" (relative to the downloaded soak-part-<N>-results/ dir). ` +
      `These must match or every night's readPartSummary reports "missing" without any step going red.`,
  );
});
