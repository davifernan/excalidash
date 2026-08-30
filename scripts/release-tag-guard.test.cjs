#!/usr/bin/env node
/**
 * Counterprobe for scripts/release-tag-guard.cjs.
 *
 * Builds a disposable git repository per case rather than touching the real
 * repository's tags -- the real repo's tag namespace is shared with a local
 * checkout's `origin` (upstream) remote (see release-tag-guard.cjs's header),
 * and a test must never create or move a tag there.
 *
 * Each RED probe plants the exact fault this check exists to catch: a bare
 * `vX.Y.Z` tag pointing at a commit the checked commit did not descend from.
 * Each GREEN case is a shape that must stay legal: no tag yet, or a tag that
 * genuinely is our own ancestor (re-checking a point we already tagged).
 */

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const {
  evaluateBareTagSafety,
  parseReleaseClaims,
  evaluateChangelogDelivery,
  readVersion,
  checkRepo,
  SEMVER_PATTERN,
} = require("./release-tag-guard.cjs");

function git(args, cwd) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function initRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-tag-guard-sandbox-"));
  git(["init", "--quiet", "--initial-branch=main"], dir);
  git(["config", "user.email", "test@example.invalid"], dir);
  git(["config", "user.name", "Release Tag Guard Test"], dir);
  return dir;
}

function commitVersion(dir, version, message = `version ${version}`) {
  fs.writeFileSync(path.join(dir, "VERSION"), version);
  git(["add", "VERSION"], dir);
  git(["commit", "--quiet", "--allow-empty", "-m", message], dir);
}

function headOf(dir) {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
}

function removeRepo(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- Pure-function cases: no repository needed ---

test("evaluateBareTagSafety: no tag at all is safe", () => {
  const result = evaluateBareTagSafety({ version: "0.7.0", tagExists: false, isAncestor: false });
  assert.equal(result.ok, true);
});

test("evaluateBareTagSafety: tag exists and is our ancestor is safe", () => {
  const result = evaluateBareTagSafety({ version: "0.7.0", tagExists: true, isAncestor: true });
  assert.equal(result.ok, true);
});

test("RED: evaluateBareTagSafety rejects a tag that exists but is not our ancestor", () => {
  const result = evaluateBareTagSafety({ version: "0.6.0", tagExists: true, isAncestor: false });
  assert.equal(result.ok, false);
  assert.match(result.findings[0], /v0\.6\.0/);
  assert.match(result.findings[0], /NOT an ancestor/);
});

test("readVersion rejects a malformed VERSION file", () => {
  const dir = initRepo();
  try {
    fs.writeFileSync(path.join(dir, "VERSION"), "v0.7.0\n");
    const result = readVersion(path.join(dir, "VERSION"));
    assert.equal(result.ok, false);
    assert.match(result.findings[0], /must be exactly/);
  } finally {
    removeRepo(dir);
  }
});

test("readVersion accepts a clean semver VERSION file", () => {
  const dir = initRepo();
  try {
    fs.writeFileSync(path.join(dir, "VERSION"), "0.7.0");
    const result = readVersion(path.join(dir, "VERSION"));
    assert.equal(result.ok, true);
    assert.equal(result.version, "0.7.0");
  } finally {
    removeRepo(dir);
  }
});

test("SEMVER_PATTERN matches only X.Y.Z", () => {
  assert.equal(SEMVER_PATTERN.test("0.7.0"), true);
  assert.equal(SEMVER_PATTERN.test("0.7"), false);
  assert.equal(SEMVER_PATTERN.test("v0.7.0"), false);
  assert.equal(SEMVER_PATTERN.test("0.7.0-dev"), false);
});

const CHANGELOG_WITH_SOURCES = `# Changelog

## v1.2.3 -- 2026-08-30

<!-- release-source: #10 -->
This release has a delivered summary claim.

### Added

<!-- release-source: #10 -->
- A delivered feature is visible to people using the product.

### Fixed

<!-- release-source: #11 -->
- A delivered repair now works.
`;

function mergedDelivery(mergeCommit = "a".repeat(40)) {
  return {
    state: "MERGED",
    mergeCommit,
    body: "User-Facing: A delivered feature is visible to people using the product.",
  };
}

test("parseReleaseClaims keeps visible changelog claims attached to their source markers", () => {
  const parsed = parseReleaseClaims(CHANGELOG_WITH_SOURCES, "1.2.3");
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.claims.map((claim) => claim.sources), [[10], [10], [11]]);
});

test("RED: the original v0.17 prose would have exposed both unmarked claims", () => {
  const historical = `# Changelog

## v0.17.0 -- 2026-08-30

This is the first release in which an agent can actually be started.

### Added

- Bring your own computer: pair a personal machine as an outbound runtime.
`;
  const result = evaluateChangelogDelivery({
    version: "0.17.0",
    changelog: historical,
    getDelivery: () => mergedDelivery(),
    isAncestor: () => true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.findings.length, 2);
  assert.match(result.findings[0], /first release in which an agent can actually be started/);
  assert.match(result.findings[1], /Bring your own computer/);
});

test("RED: a changelog claim sourced from an unmerged PR is rejected", () => {
  const result = evaluateChangelogDelivery({
    version: "1.2.3",
    changelog: CHANGELOG_WITH_SOURCES.replace("#10", "#288"),
    getDelivery: (number) =>
      number === 288
        ? { state: "OPEN", mergeCommit: null, body: "User-Facing: An unshipped feature." }
        : mergedDelivery(),
    isAncestor: () => true,
  });
  assert.equal(result.ok, false);
  assert.match(result.findings[0], /#288.*not merged/);
});

test("RED: an unmarked visible changelog claim is rejected instead of assumed delivered", () => {
  const result = evaluateChangelogDelivery({
    version: "1.2.3",
    changelog: CHANGELOG_WITH_SOURCES.replace("<!-- release-source: #10 -->\n", ""),
    getDelivery: () => mergedDelivery(),
    isAncestor: () => true,
  });
  assert.equal(result.ok, false);
  assert.match(result.findings[0], /has no release-source marker/);
});

test("RED: a merged PR outside the checked history cannot source a release claim", () => {
  const result = evaluateChangelogDelivery({
    version: "1.2.3",
    changelog: CHANGELOG_WITH_SOURCES,
    getDelivery: () => mergedDelivery(),
    isAncestor: () => false,
  });
  assert.equal(result.ok, false);
  assert.match(result.findings[0], /not an ancestor/);
});

// --- End-to-end cases against a disposable git repository ---

test("checkRepo: GREEN -- no bare tag exists yet", () => {
  const dir = initRepo();
  try {
    commitVersion(dir, "0.7.0");
    const result = checkRepo({ cwd: dir, commit: "HEAD", versionFile: path.join(dir, "VERSION") });
    assert.equal(result.ok, true);
  } finally {
    removeRepo(dir);
  }
});

test("checkRepo: GREEN -- the bare tag exists and is our own ancestor", () => {
  const dir = initRepo();
  try {
    commitVersion(dir, "0.7.0");
    git(["tag", "-a", "v0.7.0", "-m", "release"], dir);
    commitVersion(dir, "0.7.0", "a later commit on the same branch, still descends from the tag");
    const result = checkRepo({ cwd: dir, commit: "HEAD", versionFile: path.join(dir, "VERSION") });
    assert.equal(result.ok, true);
  } finally {
    removeRepo(dir);
  }
});

test("RED: checkRepo rejects a bare tag that points at a foreign, non-ancestor commit", () => {
  const dir = initRepo();
  try {
    // Simulates the real incident: a same-named tag exists, but from a
    // history our checked commit never descended from.
    commitVersion(dir, "0.1.0");
    git(["checkout", "--quiet", "-b", "foreign"], dir);
    commitVersion(dir, "0.6.0", "foreign: version 0.6.0");
    git(["tag", "-a", "v0.6.0", "-m", "a foreign release with the same name"], dir);
    const foreignHead = headOf(dir);

    git(["checkout", "--quiet", "main"], dir);
    commitVersion(dir, "0.6.0", "ours: version 0.6.0");
    const ourHead = headOf(dir);
    assert.notEqual(ourHead, foreignHead);

    const result = checkRepo({ cwd: dir, commit: "HEAD", versionFile: path.join(dir, "VERSION") });
    assert.equal(result.ok, false);
    assert.match(result.findings[0], /v0\.6\.0/);
  } finally {
    removeRepo(dir);
  }
});

test("checkRepo: invalid VERSION fails before any git lookup", () => {
  const dir = initRepo();
  try {
    commitVersion(dir, "not-a-version");
    const result = checkRepo({ cwd: dir, commit: "HEAD", versionFile: path.join(dir, "VERSION") });
    assert.equal(result.ok, false);
  } finally {
    removeRepo(dir);
  }
});
