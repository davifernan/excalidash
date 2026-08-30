#!/usr/bin/env node
/**
 * Counterprobe for scripts/npx-no-install-guard.cjs (NIL-636 soak incident).
 *
 * Reproduces the real incident shape (`cd backend && npx prisma generate`
 * with no `--no-install`) plus the surrounding shapes that must NOT be
 * flagged: a call that already has the flag, one where it appears after
 * other npx flags, a multi-line `run: |` block, an inline one-liner, a
 * `playwright install <engine>` call, and something that merely mentions
 * the word "npx" in a comment or as a substring of another word.
 */

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { findMissingNoInstall, extractRunBlocks, checkFile } = require("./npx-no-install-guard.cjs");

test("flags the real incident: cd backend && npx prisma generate", () => {
  const offenders = findMissingNoInstall("cd backend && npx prisma generate");
  assert.equal(offenders.length, 1);
  assert.match(offenders[0], /npx prisma generate/);
});

test("does not flag a call that already has --no-install", () => {
  assert.deepEqual(findMissingNoInstall("cd backend && npx --no-install prisma generate"), []);
});

test("does not flag --no-install appearing after another npx flag", () => {
  assert.deepEqual(findMissingNoInstall("npx --yes --no-install cowsay hi"), []);
});

test("treats a backslash-continued --no-install flag as part of the same npx command", () => {
  assert.deepEqual(
    findMissingNoInstall("npx \\\n  --no-install prisma generate"),
    [],
  );
});

test("still flags a backslash-continued npx command without --no-install", () => {
  const offenders = findMissingNoInstall("npx \\\n  prisma generate");
  assert.equal(offenders.length, 1);
  assert.match(offenders[0], /npx\s+prisma generate/);
});

test("flags each npx call independently on the same line", () => {
  const offenders = findMissingNoInstall("npx prisma generate && npx --no-install eslint .");
  assert.equal(offenders.length, 1);
  assert.match(offenders[0], /npx prisma generate/);
});

test("finds every chained npx call, including background commands", () => {
  for (const operator of ["&&", "||", ";", "|", "&"]) {
    const unprotectedSecond = `npx --no-install foo ${operator} npx bar`;
    assert.deepEqual(
      findMissingNoInstall(unprotectedSecond),
      ["npx bar"],
      `must flag the second npx call after ${operator}`,
    );
    const protectedBoth = `npx --no-install foo ${operator} npx --no-install bar`;
    assert.deepEqual(
      findMissingNoInstall(protectedBoth),
      [],
      `must accept separately protected npx calls around ${operator}`,
    );
  }
});

test("finds an npx call in a command substitution but ignores quoted and comment text", () => {
  assert.deepEqual(findMissingNoInstall("echo $(npx bar)"), ["npx bar"]);
  assert.deepEqual(
    findMissingNoInstall("echo 'npx bar' # npx bar"),
    [],
  );
});

test("tokenizes a GitHub Actions expression without hiding its npx command", () => {
  assert.deepEqual(
    findMissingNoInstall('npx --no-install playwright install ${{ inputs.engine }}'),
    [],
  );
  assert.deepEqual(
    findMissingNoInstall('npx playwright install ${{ inputs.engine }}'),
    ["npx playwright install GITHUB_ACTIONS_EXPRESSION"],
  );
});

test("does not flag the word 'npx' as a substring of another word", () => {
  assert.deepEqual(findMissingNoInstall("echo unnpxpected"), []);
});

test("does not flag a comment-only mention (extractRunBlocks scope, not findMissingNoInstall's job)", () => {
  // findMissingNoInstall only ever sees run: block text, never comment
  // text -- extractRunBlocks is what keeps comments out, tested below.
  const yaml = [
    "jobs:",
    "  x:",
    "    steps:",
    "      # mentions npx prisma generate in prose, not a real command",
    "      - run: echo hi",
    "",
  ].join("\n");
  const blocks = extractRunBlocks(yaml);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].text.trim(), "echo hi");
});

test("extracts a multi-line `run: |` block and flags an npx call inside it", () => {
  const yaml = [
    "jobs:",
    "  x:",
    "    steps:",
    "      - name: Generate Prisma client",
    "        run: |",
    "          cd backend",
    "          npx prisma generate",
    "      - name: next step",
    "        run: echo done",
    "",
  ].join("\n");
  const blocks = extractRunBlocks(yaml);
  assert.equal(blocks.length, 2);
  const offenders = findMissingNoInstall(blocks[0].text);
  assert.equal(offenders.length, 1);
});

test("does not flag a correctly-flagged `playwright install <engine>` call", () => {
  assert.deepEqual(
    findMissingNoInstall("cd e2e && npx --no-install playwright install chromium --with-deps"),
    [],
  );
});

test("end-to-end: checkFile reports the real incident with a line number", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "npx-no-install-guard-probe-"));
  const filePath = path.join(dir, "soak.yml");
  try {
    fs.writeFileSync(
      filePath,
      [
        "jobs:",
        "  run:",
        "    steps:",
        "      - name: Install backend dependencies",
        "        run: npm ci",
        "      - name: Generate Prisma client",
        "        run: cd backend && npx prisma generate",
        "",
      ].join("\n"),
    );
    const findings = checkFile(filePath);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].line, 7);
    assert.match(findings[0].snippet, /npx prisma generate/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("end-to-end: the real repo's current workflows are all clean", () => {
  const repoRoot = path.resolve(__dirname, "..");
  const workflowsDir = path.join(repoRoot, ".github", "workflows");
  const files = fs
    .readdirSync(workflowsDir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => path.join(workflowsDir, name));
  assert.ok(files.length > 0, "expected at least one workflow file");
  for (const file of files) {
    const findings = checkFile(file);
    assert.deepEqual(findings, [], `${path.relative(repoRoot, file)} should have no bare npx calls`);
  }
});
