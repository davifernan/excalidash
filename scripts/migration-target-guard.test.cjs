#!/usr/bin/env node
/**
 * Counterprobe for backend/scripts/migration-target-guard.cjs.
 *
 * Lives here, not next to the module it guards, because CI's script-test job
 * runs `node --test scripts/*.test.cjs` from the repository root and installs
 * only the root's dependencies. A test under backend/scripts/ would never be
 * executed and would report nothing forever -- the failure mode this file
 * exists to avoid.
 *
 * The case that matters most is the one that shipped broken in v0.20.0: a
 * target prepared exactly as docs/DEPLOYMENT.md says holds `Team(id='default')`
 * because the schema migration seeds it, and the source holds the same row for
 * the same reason. Refusing that made the documented migration impossible.
 */

const test = require("node:test");
const assert = require("node:assert");

const { normaliseId, findForeignRows } = require("../backend/scripts/migration-target-guard.cjs");

test("a target holding only rows the source also has is safe to write into", () => {
  // This is the shape the runbook produces. Refusing it is what made the
  // release's headline feature impossible to complete.
  const verdict = findForeignRows([
    { model: "Team", targetIds: ["default"], sourceIds: ["default"] },
    { model: "User", targetIds: [], sourceIds: ["u1"] },
  ]);
  assert.strictEqual(verdict.ok, true);
  assert.deepStrictEqual(verdict.findings, []);
});

test("an empty target is safe", () => {
  const verdict = findForeignRows([{ model: "Drawing", targetIds: [], sourceIds: ["d1"] }]);
  assert.strictEqual(verdict.ok, true);
});

test("a row the source has never seen is refused, named, and shown", () => {
  // Another instance's data is exactly what the check exists to catch.
  const verdict = findForeignRows([
    { model: "Drawing", targetIds: ["from-another-instance"], sourceIds: ["d1"] },
  ]);
  assert.strictEqual(verdict.ok, false);
  assert.match(verdict.findings.join(" "), /Drawing=1/);
  assert.match(verdict.findings.join(" "), /from-another-instance/);
});

test("foreign rows are counted, not just detected", () => {
  const verdict = findForeignRows([
    { model: "Drawing", targetIds: ["a", "b", "c", "known"], sourceIds: ["known"] },
  ]);
  assert.match(verdict.findings.join(" "), /Drawing=3/);
});

test("one shared id does not excuse the foreign ones beside it", () => {
  const verdict = findForeignRows([
    { model: "Team", targetIds: ["default", "someone-elses"], sourceIds: ["default"] },
  ]);
  assert.strictEqual(verdict.ok, false);
  assert.match(verdict.findings.join(" "), /someone-elses/);
});

test("a numeric id is not called foreign just because the two engines type it differently", () => {
  // SQLite hands back 7, PostgreSQL "7". Without normalisation this refuses a
  // migration that is entirely fine.
  const verdict = findForeignRows([{ model: "Counter", targetIds: [7], sourceIds: ["7"] }]);
  assert.strictEqual(verdict.ok, true);
  assert.strictEqual(normaliseId(7), "7");
});

test("a model with no single-column id falls back to refusing any row", () => {
  // No id to compare means no way to tell whose row it is, so guessing is worse
  // than being strict.
  const strict = findForeignRows([{ model: "S3File", comparable: false, targetCount: 2 }]);
  assert.strictEqual(strict.ok, false);
  assert.match(strict.findings.join(" "), /S3File=2/);

  const empty = findForeignRows([{ model: "S3File", comparable: false, targetCount: 0 }]);
  assert.strictEqual(empty.ok, true);
});

test("findings from several models are all reported, not just the first", () => {
  const verdict = findForeignRows([
    { model: "Drawing", targetIds: ["x"], sourceIds: [] },
    { model: "Collection", targetIds: ["y"], sourceIds: [] },
  ]);
  assert.strictEqual(verdict.findings.length, 2);
});
