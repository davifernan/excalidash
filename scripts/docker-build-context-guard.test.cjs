#!/usr/bin/env node
/**
 * Counterprobe for scripts/docker-build-context-guard.cjs (NIL-636).
 *
 * Reproduces the real incident in a private sandbox: a Dockerfile whose
 * COPY instructions need the repo root, built with the old `./backend`
 * -shaped context. The check must name the exact missing source. The
 * negative probes matter as much: a correct root-context build, a
 * multi-stage Dockerfile using `COPY --from=`, and a wildcard COPY must all
 * pass without complaint, or the guard would cry wolf on legitimate shapes.
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  checkBuild,
  findComposeBuildBlocks,
  relFiles,
} = require("./docker-build-context-guard.cjs");

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "docker-context-guard-probe-"));
  fs.mkdirSync(path.join(root, "backend"));
  fs.mkdirSync(path.join(root, "frontend"));
  fs.mkdirSync(path.join(root, "packages", "domain"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.writeFileSync(path.join(root, "package-lock.json"), "{}");
  fs.writeFileSync(path.join(root, "backend", "package.json"), "{}");
  fs.writeFileSync(path.join(root, "frontend", "package.json"), "{}");
  fs.writeFileSync(path.join(root, "packages", "domain", "package.json"), "{}");
  fs.writeFileSync(
    path.join(root, "backend", "Dockerfile"),
    [
      "FROM node:24-alpine AS builder",
      "WORKDIR /app",
      "COPY package.json package-lock.json ./",
      "COPY backend/package.json ./backend/package.json",
      "COPY frontend/package.json ./frontend/package.json",
      "COPY packages/domain/package.json ./packages/domain/package.json",
      "FROM node:24-alpine",
      "COPY --from=builder /app/backend/dist ./dist",
    ].join("\n"),
  );
  return root;
}

test("flags the real bug: root-context Dockerfile built with context ./backend", () => {
  const root = makeSandbox();
  try {
    const problems = checkBuild({
      label: "probe",
      contextDir: path.join(root, "backend"),
      dockerfilePath: path.join(root, "backend", "Dockerfile"),
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0].problem, /package-lock\.json/);
    assert.match(problems[0].problem, /frontend\/package\.json/);
    assert.match(problems[0].problem, /packages\/domain\/package\.json/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("passes the fixed shape: same Dockerfile built with the repo root as context", () => {
  const root = makeSandbox();
  try {
    const problems = checkBuild({
      label: "probe",
      contextDir: root,
      dockerfilePath: path.join(root, "backend", "Dockerfile"),
    });
    assert.deepEqual(problems, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("does not flag COPY --from=<stage> as a context-relative source", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "docker-context-guard-probe-"));
  try {
    fs.writeFileSync(
      path.join(root, "Dockerfile"),
      [
        "FROM node:24-alpine AS builder",
        "RUN echo hi",
        "FROM node:24-alpine",
        "COPY --from=builder /app/dist ./dist",
      ].join("\n"),
    );
    const problems = checkBuild({
      label: "probe",
      contextDir: root,
      dockerfilePath: path.join(root, "Dockerfile"),
    });
    assert.deepEqual(problems, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("treats a wildcard COPY source as present when its parent directory exists", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "docker-context-guard-probe-"));
  try {
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(
      path.join(root, "Dockerfile"),
      ["FROM node:24-alpine", "COPY src/*.ts ./src/"].join("\n"),
    );
    const problems = checkBuild({
      label: "probe",
      contextDir: root,
      dockerfilePath: path.join(root, "Dockerfile"),
    });
    assert.deepEqual(problems, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("parses a compose build: block's context and dockerfile", () => {
  const text = [
    "services:",
    "  backend:",
    "    build:",
    "      context: .",
    "      dockerfile: backend/Dockerfile",
    "    container_name: x",
  ].join("\n");
  const blocks = findComposeBuildBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].context, ".");
  assert.equal(blocks[0].dockerfile, "backend/Dockerfile");
});

test("discovers a compose file at an arbitrary, unlisted path -- not a hand-maintained list (NIL-636)", () => {
  // The real incident: local/oidc-sandbox.yml had two ./backend-context
  // build blocks and was never on any hardcoded file list, so the guard
  // that shipped alongside this exact bug passed clean regardless. This
  // proves discovery is a real filesystem walk: a compose file nested three
  // directories deep, under a name nobody could have hardcoded in advance,
  // must still turn up.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "docker-context-guard-discovery-"));
  try {
    const nested = path.join(root, "ops", "sandboxes", "totally-unlisted");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, "whatever-name.yml"), "services:\n  x: {}\n");
    fs.mkdirSync(path.join(root, "node_modules", "some-pkg"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules", "some-pkg", "compose.yml"), "services: {}\n");

    const found = relFiles(root, ".");
    assert.ok(
      found.includes("ops/sandboxes/totally-unlisted/whatever-name.yml"),
      `expected the nested, unlisted file to be discovered; got ${JSON.stringify(found)}`,
    );
    assert.ok(
      !found.some((rel) => rel.startsWith("node_modules/")),
      `node_modules must stay excluded; got ${JSON.stringify(found)}`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("end-to-end: the real repo's current build sites all pass", () => {
  const repoRoot = path.resolve(__dirname, "..");
  const composePath = path.join(repoRoot, "docker-compose.yml");
  const text = fs.readFileSync(composePath, "utf8");
  const blocks = findComposeBuildBlocks(text);
  assert.ok(blocks.length >= 2, "expected at least backend and frontend build blocks");
  for (const block of blocks) {
    const contextDir = path.resolve(path.dirname(composePath), block.context);
    const dockerfilePath = path.join(contextDir, block.dockerfile);
    const problems = checkBuild({ label: "repo", contextDir, dockerfilePath });
    assert.deepEqual(problems, [], `docker-compose.yml:${block.line} should be clean`);
  }
});
