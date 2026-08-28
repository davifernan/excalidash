"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { ARTIFACT_DIR_RELATIVE, PART_SUMMARY_FILENAME } = require("./soak-nightly-extract.cjs");
const { PART_SUMMARY_RELATIVE_PATH } = require("./soak-nightly-aggregate.cjs");

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

// upload-artifact@v4's own rule ("Uploading a Single File or Directory" /
// "Uploading Multiple Files" in its README): a single given path is itself
// the archive root (its contents are uploaded flattened, the directory name
// does not survive inside the archive); with multiple paths, the archive
// root is the least common ancestor path segment shared by all of them.
function commonAncestorSegments(pathList) {
  const segLists = pathList.map((p) => (p.endsWith("/") ? p.slice(0, -1) : p).split("/"));
  let common = segLists[0];
  for (const segs of segLists.slice(1)) {
    const len = Math.min(common.length, segs.length);
    let i = 0;
    while (i < len && common[i] === segs[i]) i++;
    common = common.slice(0, i);
  }
  return common;
}

function resolveToAbsolute(entry, workspaceDir) {
  const cleaned = entry.trim().replace(/\$\{\{\s*inputs\.part\s*\}\}/g, "1");
  return cleaned.startsWith("/") ? cleaned : path.posix.join(workspaceDir, cleaned);
}

// Extracts the literal `path:` value(s) of one named step from the
// workflow's real YAML text -- no YAML dependency in scripts/ (same
// approach as workflow-timeouts.test.cjs), and reading the file itself
// rather than a fixture means an edit to the real step is exactly what this
// test reacts to.
function extractStepPaths(workflowSource, stepName) {
  const lines = workflowSource.split(/\r?\n/);
  const stepStart = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
  assert.notStrictEqual(stepStart, -1, `step "${stepName}" not found in ${WORKFLOW_PATH}`);

  let stepEnd = lines.length;
  for (let i = stepStart + 1; i < lines.length; i++) {
    if (/^ {6}- name:/.test(lines[i])) {
      stepEnd = i;
      break;
    }
  }
  const block = lines.slice(stepStart, stepEnd);

  const singleLine = block.find((l) => /^\s*path:\s*\S/.test(l));
  if (singleLine) {
    return [singleLine.replace(/^\s*path:\s*/, "").trim()];
  }

  const blockStart = block.findIndex((l) => /^\s*path:\s*\|/.test(l));
  assert.notStrictEqual(blockStart, -1, `no "path:" under step "${stepName}"`);
  const baseIndent = block[blockStart].match(/^(\s*)/)[1].length;
  const paths = [];
  for (let i = blockStart + 1; i < block.length; i++) {
    const line = block[i];
    if (line.trim() === "") continue;
    const indent = line.match(/^(\s*)/)[1].length;
    if (indent <= baseIndent) break;
    paths.push(line.trim());
  }
  assert.ok(paths.length > 0, `"path:" block under step "${stepName}" had no entries`);
  return paths;
}

test("soak-part.yml's upload path resolves to where the aggregator reads part-summary.json", () => {
  const workflowSource = fs.readFileSync(WORKFLOW_PATH, "utf8");
  const configuredPaths = extractStepPaths(workflowSource, STEP_NAME);

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
