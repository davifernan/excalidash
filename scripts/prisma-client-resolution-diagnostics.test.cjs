#!/usr/bin/env node
/**
 * NIL-703 red proof: corrupt the generated package.json by file copy, then
 * run a real Vitest suite import. The custom runner must capture the failing
 * fork's PID/worker, precise timestamp, package bytes/hash/content before and
 * after import, and the generation and passed-integrity markers.
 */

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const backendRoot = path.join(root, "backend");
const packageJson = path.join(backendRoot, "src", "generated", "client", "package.json");
const fixture = "src/__tests__/prismaClientResolutionFixture.test.ts";
// Resolved from vitest's own package.json, not `backend/node_modules/...`
// directly: the root Workspace hoists `vitest` to the repo root, and
// `vitest/vitest.mjs` itself is not an exported subpath (its package.json
// `exports` map rejects a direct `require.resolve("vitest/vitest.mjs")`),
// so the executable is located relative to the package root instead
// (NIL-624).
const resolveVitestCli = () =>
  path.join(
    path.dirname(require.resolve("vitest/package.json", { paths: [root, backendRoot] })),
    "vitest.mjs",
  );
const invalidPackageFixture = path.join(
  root,
  "scripts",
  "fixtures",
  "nil-703-invalid-package.json",
);

if (!fs.existsSync(packageJson)) {
  console.log(
    "SKIPPED: generated Prisma client is absent; run `npx prisma generate` in backend first.",
  );
  process.exit(0);
}

const vitestCli = resolveVitestCli();

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nil703-resolution-diagnostic-"));
const backup = path.join(tempRoot, "package.json.backup");
const diagnosticDirectory = path.join(tempRoot, "diagnostics");
const generationMarker = path.join(tempRoot, "prisma-generate-finished.json");
const integrityMarker = path.join(tempRoot, "prisma-client-integrity.json");
fs.copyFileSync(packageJson, backup);
fs.writeFileSync(
  generationMarker,
  `${JSON.stringify({ finishedAt: "2026-08-30T10:08:09.123Z", probe: "simulated after prisma generate" })}\n`,
);
fs.writeFileSync(
  integrityMarker,
  `${JSON.stringify({ finishedAt: "2026-08-30T10:08:11.456Z", probe: "simulated passed integrity check" })}\n`,
);

try {
  // Direct file replacement from a copied fixture, never git checkout: this
  // is the exact invalid package-config shape that the production failure
  // reported.
  fs.copyFileSync(invalidPackageFixture, packageJson);
  const result = spawnSync(process.execPath, [vitestCli, "run", fixture, "--reporter=dot"], {
    cwd: backendRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      NIL703_PRISMA_DIAGNOSTIC_DIR: diagnosticDirectory,
      NIL703_PRISMA_GENERATE_MARKER: generationMarker,
      NIL703_PRISMA_INTEGRITY_MARKER: integrityMarker,
    },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.notEqual(result.status, 0, `expected invalid package config to fail:\n${output}`);

  const diagnostics = fs
    .readdirSync(diagnosticDirectory)
    .filter((entry) => entry.endsWith(".json"));
  assert.equal(
    diagnostics.length,
    1,
    `expected one diagnostic, got ${diagnostics.length}: ${output}`,
  );
  const diagnostic = JSON.parse(
    fs.readFileSync(path.join(diagnosticDirectory, diagnostics[0]), "utf8"),
  );
  assert.equal(diagnostic.schema, "nil-703-prisma-client-resolution-diagnostic/v1");
  assert.equal(typeof diagnostic.capturedAt, "string");
  assert.equal(typeof diagnostic.failingProcess.pid, "number");
  assert.equal(typeof diagnostic.failingProcess.workerId, "string");
  assert.equal(diagnostic.failingImport.suiteImportAttempt, 1);
  const invalidPackageBytes = fs.readFileSync(invalidPackageFixture);
  for (const snapshot of [
    diagnostic.packageJson.beforeImport,
    diagnostic.packageJson.afterImport,
  ]) {
    assert.equal(typeof snapshot.capturedAt, "string");
    assert.equal(typeof snapshot.capturedAtHrtimeNs, "string");
    assert.equal(snapshot.bytes, invalidPackageBytes.byteLength);
    assert.equal(snapshot.utf8, invalidPackageBytes.toString("utf8"));
    assert.match(snapshot.sha256, /^[a-f0-9]{64}$/);
  }
  assert.equal(
    diagnostic.prismaClientIntegrityVerified.value.finishedAt,
    "2026-08-30T10:08:11.456Z",
  );
  assert.equal(typeof diagnostic.prismaClientIntegrityVerified.elapsedMsAtFailure, "number");
  assert.equal(diagnostic.prismaGenerateFinished.value.finishedAt, "2026-08-30T10:08:09.123Z");
  assert.equal(typeof diagnostic.prismaGenerateFinished.elapsedMsAtFailure, "number");
  console.log(
    `red probe captured PID ${diagnostic.failingProcess.pid}, worker ${diagnostic.failingProcess.workerId}, ` +
      `timestamp ${diagnostic.capturedAt}, suite import ${diagnostic.failingImport.suiteImportAttempt}, ` +
      `${diagnostic.packageJson.beforeImport.bytes}/${diagnostic.packageJson.afterImport.bytes} package bytes before/after import, ` +
      `integrity marker ${diagnostic.prismaClientIntegrityVerified.value.finishedAt}, ` +
      `and prisma marker ${diagnostic.prismaGenerateFinished.value.finishedAt}`,
  );
} finally {
  fs.copyFileSync(backup, packageJson);
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

const green = spawnSync(process.execPath, [vitestCli, "run", fixture, "--reporter=dot"], {
  cwd: backendRoot,
  encoding: "utf8",
});
assert.equal(green.status, 0, `expected restored package to pass:\n${green.stdout}${green.stderr}`);
console.log("green again after restoring the copied package.json bytes");
