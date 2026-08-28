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
  rawEvidenceUrl,
  validatePublication,
} = require("./motion-evidence.cjs");

test("motion evidence uses bounded GIF settings and a durable evidence URL", () => {
  assert.equal(MAX_DURATION_SECONDS, 12);
  assert.equal(MAX_BYTES, 5 * 1024 * 1024);
  assert.equal(GIF_WIDTH, 640);
  assert.equal(GIF_FPS, 8);
  assert.equal(gifFilename("connected-child-latency"), "connected-child-latency.gif");
  assert.equal(
    rawEvidenceUrl("NIL-650", "connected-child-latency.gif"),
    "https://raw.githubusercontent.com/davifernan/excalidash/evidence/motion/NIL-650/connected-child-latency.gif",
  );
});

test("publication names cannot overwrite or escape the evidence tree", () => {
  assert.doesNotThrow(() => validatePublication({ packageId: "NIL-650", name: "connected-child-latency" }));
  assert.throws(() => validatePublication({ packageId: "650", name: "connected-child" }), /NIL-NNN/);
  assert.throws(() => validatePublication({ packageId: "NIL-650", name: "../replace" }), /lowercase/);
});

test("option parsing requires every named option to have a value", () => {
  assert.deepEqual(parseOptions(["--package", "NIL-650", "--pr", "42"]), {
    package: "NIL-650",
    pr: "42",
  });
  assert.throws(() => parseOptions(["--package"]), /Missing value/);
  assert.throws(() => parseOptions(["NIL-650"]), /Unexpected argument/);
});
