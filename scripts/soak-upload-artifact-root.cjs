"use strict";

// Shared by soak-artifact-layout.test.cjs and soak-db-asset-restore.test.cjs:
// both re-derive where upload-artifact@v4 actually places files inside an
// archive from a workflow step's own configured `path:`, rather than
// asserting "the path string looks right". Splitting this out once both
// tests needed the identical model keeps the two in lockstep instead of two
// copies that could quietly drift.
//
// upload-artifact@v4's own rule ("Uploading a Single File or Directory" /
// "Uploading Multiple Files" in its README): a single given path is itself
// the archive root (its contents are uploaded flattened, the directory name
// does not survive inside the archive); with multiple paths, the archive
// root is the least common ancestor path segment shared by all of them.

const fs = require("fs");
const assert = require("node:assert");

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
  const cleaned = entry
    .trim()
    .replace(/\$\{\{\s*inputs\.part\s*\}\}/g, "1")
    .replace(/\/\*\*$/, "");
  return cleaned.startsWith("/") ? cleaned : require("path").posix.join(workspaceDir, cleaned);
}

// Extracts the literal `path:` value(s) of one named step from a workflow's
// real YAML text -- no YAML dependency in scripts/ (same approach as
// workflow-timeouts.test.cjs), and reading the file itself rather than a
// fixture means an edit to the real step is exactly what a test using this
// reacts to.
function extractStepPaths(workflowSource, stepName, workflowPath) {
  const lines = workflowSource.split(/\r?\n/);
  const stepStart = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
  assert.notStrictEqual(stepStart, -1, `step "${stepName}" not found in ${workflowPath}`);

  let stepEnd = lines.length;
  for (let i = stepStart + 1; i < lines.length; i++) {
    if (/^ {6}- name:/.test(lines[i])) {
      stepEnd = i;
      break;
    }
  }
  const block = lines.slice(stepStart, stepEnd);

  // Excludes YAML block-scalar indicators ("|", "|-", ">", ">-"): those
  // introduce a multi-line block, they are not a single-line value. A bug
  // here once made this match "path: |" itself as if the path were the
  // literal string "|", silently picking the wrong step's content whenever
  // that step used a block-scalar `path:` -- caught by this file's own
  // test going red for the wrong reason (a bogus root) before the fix.
  const singleLine = block.find((l) => /^\s*path:\s*(?!\|-?\s*$|>-?\s*$)\S/.test(l));
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

function archiveRootFor(workflowPath, stepName, workspaceDir) {
  const workflowSource = fs.readFileSync(workflowPath, "utf8");
  const configuredPaths = extractStepPaths(workflowSource, stepName, workflowPath);
  const absolutePaths = configuredPaths.map((p) => resolveToAbsolute(p, workspaceDir));
  const segments = commonAncestorSegments(absolutePaths);
  return segments.join("/") || "/";
}

module.exports = {
  commonAncestorSegments,
  resolveToAbsolute,
  extractStepPaths,
  archiveRootFor,
};
