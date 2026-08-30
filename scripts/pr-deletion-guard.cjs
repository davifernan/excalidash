#!/usr/bin/env node
"use strict";

// A deleted file cannot fail a test that no longer runs it. This guard makes
// removals visible to review instead: it compares the PR head with its
// merge-base (not today's main tip), then requires the PR body to name the
// exact removed paths and a reason. The merge-base matters because a branch
// that simply has not merged recent main must never be blamed for main's own
// deletions.

const { execFileSync } = require("node:child_process");

function fieldValues(body, label) {
  return [...String(body || "").matchAll(new RegExp(`^${label}:\\s*(.*)$`, "gm"))].map((match) =>
    match[1].trim(),
  );
}

function parseDeletionDeclaration(body) {
  const declarations = fieldValues(body, "Deletes-Files");
  if (declarations.length === 0) return { ok: true, declared: null, reason: null };
  if (declarations.length !== 1) {
    return {
      ok: false,
      findings: ["PR body must contain at most one `Deletes-Files:` declaration."],
    };
  }

  const raw = declarations[0];
  const declared = raw === "none" ? [] : raw.split(",").map((value) => value.trim());
  if (declared.length === 0 || declared.some((value) => value === "")) {
    return {
      ok: false,
      findings: ["`Deletes-Files:` must be `none` or a comma-separated path list."],
    };
  }
  if (new Set(declared).size !== declared.length) {
    return { ok: false, findings: ["`Deletes-Files:` must not name the same path twice."] };
  }

  const reasons = fieldValues(body, "Deletion-Reason");
  if (declared.length === 0) {
    if (reasons.length > 0) {
      return { ok: false, findings: ["`Deletion-Reason:` is only valid alongside removed files."] };
    }
    return { ok: true, declared, reason: null };
  }
  if (reasons.length !== 1 || reasons[0] === "") {
    return {
      ok: false,
      findings: ["A non-empty `Deletion-Reason:` must accompany declared removed files."],
    };
  }
  return { ok: true, declared, reason: reasons[0] };
}

function runGit(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function deletedFilesSinceMergeBase({ cwd, baseSha, headSha }) {
  const mergeBase = runGit(["merge-base", baseSha, headSha], cwd);
  const output = runGit(["diff", "--name-only", "--diff-filter=D", mergeBase, headSha], cwd);
  return {
    mergeBase,
    files: output === "" ? [] : output.split("\n"),
  };
}

function evaluateDeletionDeclaration({ deletedFiles, body }) {
  const parsed = parseDeletionDeclaration(body);
  if (!parsed.ok) return parsed;

  const deleted = [...deletedFiles].sort();
  if (deleted.length === 0) {
    if (parsed.declared && parsed.declared.length > 0) {
      return {
        ok: false,
        findings: [
          `PR body declares removed files, but this PR deletes none: ${parsed.declared.join(", ")}.`,
        ],
      };
    }
    return { ok: true, findings: [], deletedFiles: [], reason: null };
  }
  if (parsed.declared === null) {
    return {
      ok: false,
      findings: [
        `This PR removes ${deleted.length} file(s) since its merge-base but has no ` +
          "`Deletes-Files:` declaration: " +
          deleted.join(", "),
      ],
    };
  }

  const declared = [...parsed.declared].sort();
  const undeclared = deleted.filter((file) => !declared.includes(file));
  const stale = declared.filter((file) => !deleted.includes(file));
  const findings = [];
  if (undeclared.length > 0) findings.push(`Removed but undeclared: ${undeclared.join(", ")}.`);
  if (stale.length > 0) findings.push(`Declared but not removed by this PR: ${stale.join(", ")}.`);
  if (findings.length > 0) return { ok: false, findings };

  return { ok: true, findings: [], deletedFiles: deleted, reason: parsed.reason };
}

function checkRepo({ cwd = process.cwd(), baseSha, headSha = "HEAD", body } = {}) {
  if (!baseSha) return { ok: false, findings: ["PR deletion guard requires PR_BASE_SHA."] };
  try {
    const { mergeBase, files } = deletedFilesSinceMergeBase({ cwd, baseSha, headSha });
    const result = evaluateDeletionDeclaration({ deletedFiles: files, body });
    return { ...result, mergeBase };
  } catch (error) {
    return { ok: false, findings: [`Cannot determine files removed by this PR: ${error.message}`] };
  }
}

function main() {
  const result = checkRepo({
    baseSha: process.env.PR_BASE_SHA,
    headSha: process.env.PR_HEAD_SHA || "HEAD",
    body: process.env.PR_BODY,
  });
  if (!result.ok) {
    for (const finding of result.findings) console.error(`PR deletion guard: ${finding}`);
    process.exitCode = 1;
    return;
  }
  if (result.deletedFiles.length === 0) {
    console.log(`PR deletion guard: no files removed since merge-base ${result.mergeBase}.`);
    return;
  }
  console.log(`PR deletion guard: declared removals since merge-base ${result.mergeBase}:`);
  for (const file of result.deletedFiles) console.log(`- ${file}`);
  console.log(`Reason: ${result.reason}`);
}

if (require.main === module) main();

module.exports = {
  checkRepo,
  deletedFilesSinceMergeBase,
  evaluateDeletionDeclaration,
  parseDeletionDeclaration,
};
