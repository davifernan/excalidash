#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const { createSandbox, removeSandbox } = require("./test-helpers/sandbox-tree.cjs");

const repoRoot = path.resolve(__dirname, "..");

test("the notification boundary accepts the facade and rejects a direct Sonner import", () => {
  const root = createSandbox(
    repoRoot,
    ["frontend/src", "scripts/notification-boundary.cjs"],
    "notification-boundary-sandbox-",
  );
  const check = path.join(root, "scripts", "notification-boundary.cjs");
  const probe = path.join(root, "frontend", "src", "notification-boundary-probe.ts");
  const run = () => spawnSync("node", [check], { cwd: root, encoding: "utf8" });

  try {
    const clean = run();
    assert.equal(clean.status, 0, clean.stderr);

    fs.writeFileSync(
      probe,
      'import { toast } from "sonner";\nexport const probe = () => toast.error("red");\n',
      "utf8",
    );
    const red = run();
    assert.equal(red.status, 1, `${red.stdout}\n${red.stderr}`);
    assert.match(red.stderr, /notification-boundary-probe\.ts/);

    fs.rmSync(probe);
    const restored = run();
    assert.equal(restored.status, 0, restored.stderr);
  } finally {
    removeSandbox(root);
  }
});
