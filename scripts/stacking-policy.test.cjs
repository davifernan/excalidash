#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const check = path.join(repoRoot, "scripts", "stacking-policy.cjs");
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "stacking-policy-"));
const source = path.join(sandbox, "frontend", "src");

const run = () =>
  spawnSync("node", [check], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, STACKING_POLICY_ROOT: sandbox },
  });

const output = (result) => `${result.stdout || ""}${result.stderr || ""}`;
const write = (relative, contents) => {
  const file = path.join(sandbox, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, "utf8");
  return relative;
};

try {
  write(
    "frontend/src/integrations/excalidraw/stacking.css",
    ":root { --excalidash-z-modal: var(--zIndex-modal, 1000); }\n",
  );
  write("frontend/src/semantic.css", ".dialog { z-index: var(--excalidash-z-modal); }\n");
  assert.equal(run().status, 0, "semantic adapter roles must be accepted");

  const probes = [
    ["frontend/src/raw.css", ".dialog { z-index: 1000000000; }\n", "CSS z-index"],
    ["frontend/src/raw.tsx", "export const style = { zIndex: 50 };\n", "inline zIndex"],
    ["frontend/src/raw-utility.tsx", 'export const c = "fixed focus:z-[100]";\n', "numeric utility"],
  ];
  for (const [file, contents, label] of probes) {
    write(file, contents);
    const result = run();
    assert.equal(result.status, 1, `${label} must turn the guard red`);
    assert.match(output(result), new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    fs.rmSync(path.join(sandbox, file));
  }

  write("frontend/src/node_modules/package/index.css", ".foreign { z-index: 999999999; }\n");
  write("frontend/src/vendor/package.css", ".foreign { z-index: 999999999; }\n");
  write("frontend/src/copied.vendor.css", ".foreign { z-index: 999999999; }\n");
  write("frontend/src/copied.min.css", ".foreign { z-index: 999999999; }\n");
  assert.equal(run().status, 0, "node_modules and foreign stylesheets must be excluded");

  console.log("Stacking policy counterprobes passed (raw values red; foreign CSS green).");
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
