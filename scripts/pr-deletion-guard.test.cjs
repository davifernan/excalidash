"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { checkRepo, evaluateDeletionDeclaration } = require("./pr-deletion-guard.cjs");

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const FEATURE_CONTENT = [
  "security-check=required",
  ...Array.from({ length: 20 }, (_, index) => `# unchanged comment ${index + 1}`),
  "",
].join("\n");

function fixtureRepo(featureChange = "delete") {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pr-deletion-guard-"));
  git(["init", "--quiet", "--initial-branch=main"], cwd);
  git(["config", "user.name", "PR deletion guard test"], cwd);
  git(["config", "user.email", "test@example.invalid"], cwd);
  write(path.join(cwd, "kept.txt"), "kept\n");
  write(path.join(cwd, "feature-only.txt"), FEATURE_CONTENT);
  write(path.join(cwd, "main-only.txt"), "remove on main later\n");
  git(["add", "."], cwd);
  git(["commit", "--quiet", "-m", "base"], cwd);
  git(["branch", "feature"], cwd);
  fs.rmSync(path.join(cwd, "main-only.txt"));
  git(["add", "-A"], cwd);
  git(["commit", "--quiet", "-m", "main deletes its own file"], cwd);
  git(["switch", "--quiet", "feature"], cwd);
  if (featureChange === "delete") {
    fs.rmSync(path.join(cwd, "feature-only.txt"));
  } else {
    const source = path.join(cwd, "feature-only.txt");
    const renamed = path.join(cwd, "renamed-feature.txt");
    fs.copyFileSync(source, renamed);
    fs.rmSync(source);
    if (featureChange === "edited-rename") {
      write(renamed, FEATURE_CONTENT.split("\n").slice(1).join("\n"));
    }
  }
  git(["add", "-A"], cwd);
  git(["commit", "--quiet", "-m", "feature deletion"], cwd);
  return cwd;
}

function removeFixture(cwd) {
  fs.rmSync(cwd, { recursive: true, force: true });
}

const DECLARATION =
  "Deletes-Files: feature-only.txt\nDeletion-Reason: Remove the replaced feature fixture.";

test("GREEN: exact declared removals are printed from the PR merge-base, not main's tip", () => {
  const cwd = fixtureRepo();
  try {
    const result = checkRepo({ cwd, baseSha: "main", headSha: "HEAD", body: DECLARATION });
    assert.equal(result.ok, true);
    assert.deepEqual(result.deletedFiles, ["feature-only.txt"]);
    assert.equal(result.reason, "Remove the replaced feature fixture.");
  } finally {
    removeFixture(cwd);
  }
});

test("RED: checkRepo names an actual undeclared deletion from a temporary Git repository", () => {
  const cwd = fixtureRepo();
  try {
    const result = checkRepo({ cwd, baseSha: "main", headSha: "HEAD", body: "" });
    assert.equal(result.ok, false);
    assert.match(result.findings[0], /feature-only\.txt/);
    assert.match(result.findings[0], /no `Deletes-Files:` declaration/);
  } finally {
    removeFixture(cwd);
  }
});

test("RED then GREEN: a changed rename exposes its old path and accepts its exact declaration", () => {
  const cwd = fixtureRepo("edited-rename");
  try {
    assert.match(
      git(["diff", "--name-status", "-M", "main...HEAD"], cwd),
      /R\d+\s+feature-only\.txt/,
    );
    const result = checkRepo({ cwd, baseSha: "main", headSha: "HEAD", body: "" });
    assert.equal(result.ok, false);
    assert.match(result.findings[0], /feature-only\.txt/);

    const declared = checkRepo({
      cwd,
      baseSha: "main",
      headSha: "HEAD",
      body: "Deletes-Files: feature-only.txt\nDeletion-Reason: Replace the edited fixture.",
    });
    assert.equal(declared.ok, true);
    assert.deepEqual(declared.deletedFiles, ["feature-only.txt"]);
  } finally {
    removeFixture(cwd);
  }
});

test("GREEN: a byte-for-byte rename remains outside the deletion declaration", () => {
  const cwd = fixtureRepo("exact-rename");
  try {
    assert.match(
      git(["diff", "--name-status", "-M", "main...HEAD"], cwd),
      /R100\s+feature-only\.txt/,
    );
    assert.equal(checkRepo({ cwd, baseSha: "main", headSha: "HEAD", body: "" }).ok, true);
  } finally {
    removeFixture(cwd);
  }
});

test("RED: an undeclared deletion is rejected by declaration evaluation", () => {
  const result = evaluateDeletionDeclaration({ deletedFiles: ["migration.sql"], body: "" });
  assert.equal(result.ok, false);
  assert.match(result.findings[0], /migration\.sql/);
  assert.match(result.findings[0], /no `Deletes-Files:` declaration/);
});

test("RED: an incomplete or stale declaration cannot make a removal disappear", () => {
  const incomplete = evaluateDeletionDeclaration({
    deletedFiles: ["a.txt", "b.txt"],
    body: "Deletes-Files: a.txt\nDeletion-Reason: Remove obsolete files.",
  });
  assert.equal(incomplete.ok, false);
  assert.match(incomplete.findings[0], /b\.txt/);

  const stale = evaluateDeletionDeclaration({
    deletedFiles: ["a.txt"],
    body: "Deletes-Files: a.txt, b.txt\nDeletion-Reason: Remove obsolete files.",
  });
  assert.equal(stale.ok, false);
  assert.match(stale.findings[0], /b\.txt/);
});

test("GREEN: no deletion needs no declaration, while a stale declaration remains red", () => {
  assert.equal(evaluateDeletionDeclaration({ deletedFiles: [], body: "" }).ok, true);
  const result = evaluateDeletionDeclaration({
    deletedFiles: [],
    body: "Deletes-Files: old.txt\nDeletion-Reason: Remove obsolete files.",
  });
  assert.equal(result.ok, false);
  assert.match(result.findings[0], /deletes none/);
});

test("the real Delivery Contract Tests workflow invokes the guard for pull requests", () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, "..", ".github", "workflows", "test.yml"),
    "utf8",
  );
  assert.match(workflow, /name: Check declared PR file deletions/);
  assert.match(workflow, /if: github\.event_name == 'pull_request'/);
  assert.match(workflow, /run: node scripts\/pr-deletion-guard\.cjs/);
  assert.match(workflow, /PR_BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(workflow, /PR_HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(workflow, /PR_BODY: \$\{\{ github\.event\.pull_request\.body \}\}/);
});
