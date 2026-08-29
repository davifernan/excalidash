"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  GIF_FPS,
  GIF_WIDTH,
  MAX_BYTES,
  MAX_DURATION_SECONDS,
  gifFilename,
  parseOptions,
  evidenceUrl,
  pushEvidenceWithRetry,
  validatePublication,
} = require("./motion-evidence.cjs");
const { REQUIRED_GIT_IDENTITY } = require("./delivery-contracts.cjs");

test("motion evidence uses bounded GIF settings and a durable evidence URL", () => {
  assert.equal(REQUIRED_GIT_IDENTITY, "Nilo <127136134+davifernan@users.noreply.github.com>");
  assert.equal(MAX_DURATION_SECONDS, 12);
  assert.equal(MAX_BYTES, 5 * 1024 * 1024);
  assert.equal(GIF_WIDTH, 640);
  assert.equal(GIF_FPS, 8);
  assert.equal(gifFilename("connected-child-latency"), "connected-child-latency.gif");
  assert.equal(
    evidenceUrl("NIL-650", "connected-child-latency.gif"),
    "https://github.com/davifernan/excalidash/blob/evidence/motion/NIL-650/connected-child-latency.gif?raw=true",
  );
});

test("publication names cannot overwrite or escape the evidence tree", () => {
  assert.doesNotThrow(() =>
    validatePublication({ packageId: "NIL-650", name: "connected-child-latency" }),
  );
  assert.throws(
    () => validatePublication({ packageId: "650", name: "connected-child" }),
    /NIL-NNN/,
  );
  assert.throws(
    () => validatePublication({ packageId: "NIL-650", name: "../replace" }),
    /lowercase/,
  );
});

test("option parsing requires every named option to have a value", () => {
  assert.deepEqual(parseOptions(["--package", "NIL-650", "--pr", "42"]), {
    package: "NIL-650",
    pr: "42",
  });
  assert.throws(() => parseOptions(["--package"]), /Missing value/);
  assert.throws(() => parseOptions(["NIL-650"]), /Unexpected argument/);
});

test("evidence publication rebases and retries a concurrent append without force-pushing", () => {
  const calls = [];
  let pushes = 0;
  const run = (executable, args, options) => {
    calls.push({ executable, args, options });
    if (executable === "git" && args[0] === "push") {
      pushes += 1;
      if (pushes === 1) throw new Error("non-fast-forward");
    }
    return "";
  };

  pushEvidenceWithRetry({ worktree: "/tmp/evidence", root: "/repo", run });

  assert.deepEqual(
    calls.map(({ executable, args, options }) => [executable, args, options.cwd]),
    [
      ["git", ["push", "fork", "HEAD:refs/heads/evidence"], "/tmp/evidence"],
      ["git", ["fetch", "fork", "evidence"], "/repo"],
      ["git", ["rebase", "fork/evidence"], "/tmp/evidence"],
      ["git", ["push", "fork", "HEAD:refs/heads/evidence"], "/tmp/evidence"],
    ],
  );
  assert.equal(
    calls.some(({ args }) => args.includes("--force") || args.includes("--force-with-lease")),
    false,
  );
});
