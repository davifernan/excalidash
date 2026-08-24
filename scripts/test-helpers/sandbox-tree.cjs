#!/usr/bin/env node
/**
 * Private tree copy for a boundary-check counterprobe (NIL-493).
 *
 * adapter-boundary.test.cjs and authz-boundary.test.cjs plant probe files
 * inside the real source tree, run the check over it, then remove them.
 * `node --test` runs test files in parallel, so one file's scan can observe
 * (or trip over the deletion of) the other file's probe directory. Copying
 * exactly the subtrees a check reads into a private temp directory means a
 * probe cycle only ever sees writes it made itself.
 *
 * The check scripts compute their own root as `path.resolve(__dirname, "..")`,
 * so the copy must include the check script itself: pointing spawnSync at a
 * copied script file makes that script's root resolve to the sandbox, not the
 * real repo.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const createSandbox = (root, relPaths, prefix) => {
  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const rel of relPaths) {
    const src = path.join(root, rel);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(sandboxRoot, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
  }
  return sandboxRoot;
};

const removeSandbox = (sandboxRoot) => {
  fs.rmSync(sandboxRoot, { recursive: true, force: true });
};

module.exports = { createSandbox, removeSandbox };
