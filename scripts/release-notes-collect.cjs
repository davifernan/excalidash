#!/usr/bin/env node
/**
 * Collects release notes from the `User-Facing:` line every PR contract now
 * requires (scripts/delivery-v2.cjs, NIL-507) -- it never writes prose of its
 * own. The only thing this script formulates is which of three buckets
 * (Added / Fixed / Changed) a collected sentence goes under; the sentence
 * itself is always the implementer's own words, copied verbatim.
 *
 * Why at tag time and not per-merge: Davi's framing (24.08.2026) is that the
 * only person who reliably knows what a user will notice is the implementer,
 * at the moment they open the PR -- so the contract captures it there. But
 * *assembling* those lines into one release's notes has to happen once, over
 * the whole range since the previous release, which is only knowable when
 * the release actually happens.
 *
 * Adapter split (same shape as pipeline-sentinel.cjs's createLiveAdapter):
 * `collect()` takes injected `listMerges`/`getPrBody` functions so the
 * grouping and rendering logic can be tested without a real repository or
 * `gh` credentials. `createLiveCollector()` wires the real `git`/`gh` calls
 * for the CLI entry point used by .github/workflows/release.yml.
 */

"use strict";

const { execFileSync } = require("node:child_process");
const { fieldValues, USER_FACING_NONE } = require("./delivery-v2.cjs");

const PR_NUMBER_PATTERN = /#(\d+)/g;
const FEAT_PREFIX = /^(?:merge:\s*)?feat(?:\([^)]*\))?[:\-]/i;
const FIX_PREFIX = /^(?:merge:\s*)?fix(?:\([^)]*\))?[:\-]/i;

/** Last `#NNN` in a merge subject is the PR number -- "(NIL-501, #75)" and
 * "Merge pull request #42 from ..." both resolve correctly under "last". */
function extractPrNumber(mergeSubject) {
  const matches = [...String(mergeSubject || "").matchAll(PR_NUMBER_PATTERN)];
  if (matches.length === 0) return null;
  return Number(matches[matches.length - 1][1]);
}

/** Best-effort bucket from the PR's own commit subjects. A PR mixing feat
 * and fix commits, or using neither convention, lands in "Changed" rather
 * than guessing -- this only sorts a human-polished draft, it never decides
 * what ships. */
function categorize(commitSubjects) {
  let feat = 0;
  let fix = 0;
  for (const subject of commitSubjects || []) {
    if (FEAT_PREFIX.test(subject)) feat += 1;
    else if (FIX_PREFIX.test(subject)) fix += 1;
  }
  if (feat > 0 && feat > fix) return "Added";
  if (fix > 0 && fix > feat) return "Fixed";
  return "Changed";
}

/** Extracts the User-Facing line without requiring the rest of the contract
 * to be well-formed -- unlike parsePrDeliveryContract, a malformed or
 * pre-contract PR body must not crash the whole collection run. Returns null
 * when nothing usable is present (missing, duplicated, or `none`). */
function extractUserFacingSentence(body) {
  const values = fieldValues(body || "", "User-Facing");
  if (values.length !== 1) return null;
  const sentence = values[0].trim();
  if (sentence.length === 0 || sentence === USER_FACING_NONE) return null;
  return sentence;
}

function renderGroup(title, entries) {
  if (entries.length === 0) return "";
  return `### ${title}\n\n${entries.map((entry) => `- ${entry}`).join("\n")}\n`;
}

/** Renders only the body groups (Added/Fixed/Changed) -- the surrounding
 * version heading and upgrade-steps boilerplate are the human's job when
 * polishing the draft, per docs/architecture/RELEASE_PROCESS.md. */
function renderNotesMarkdown({ added = [], fixed = [], changed = [] }) {
  const groups = [renderGroup("Added", added), renderGroup("Fixed", fixed), renderGroup("Changed", changed)]
    .filter(Boolean);
  if (groups.length === 0) {
    return "_No `User-Facing:` entries were collected for this range -- every merged package in it declared `User-Facing: none`, or none had a recognized contract yet. Verify this is expected before publishing._\n";
  }
  return groups.join("\n");
}

/**
 * Walks merge commits in `previousRef..headRef`, resolves each to a PR
 * number, and asks the injected adapter for that PR's body and the commit
 * subjects on its branch. Skips (with a warning, not a failure) any merge
 * that yields no PR number, no fetchable body, or no usable User-Facing
 * sentence -- an incomplete note is a smaller failure than an aborted
 * release, and the draft is reviewed by a human before it goes out.
 */
function collect({ listMerges, getPrBody, getPrCommitSubjects }) {
  const merges = listMerges();
  const added = [];
  const fixed = [];
  const changed = [];
  const warnings = [];
  const seen = new Set();

  for (const merge of merges) {
    const prNumber = extractPrNumber(merge.subject);
    if (prNumber === null) {
      warnings.push(`${merge.sha.slice(0, 12)}: no PR number found in "${merge.subject}", skipped`);
      continue;
    }

    let body;
    try {
      body = getPrBody(prNumber);
    } catch (error) {
      warnings.push(`#${prNumber}: could not fetch PR body (${error.message}), skipped`);
      continue;
    }

    const sentence = extractUserFacingSentence(body);
    if (sentence === null) {
      warnings.push(`#${prNumber}: no usable User-Facing sentence (missing, malformed, or "none"), skipped`);
      continue;
    }

    const subjects = getPrCommitSubjects(prNumber, merge);
    const bucket = categorize(subjects);
    // The same User-Facing sentence legitimately reaches this loop more than
    // once: a delivery is merged into a collect branch, and that branch is
    // merged again, so `git log --merges` sees several merges that resolve to
    // the same promise. Collect branches are the normal path here -- pushing
    // straight to `main` is rejected, and merging one PR at a time costs a
    // full CI cycle each -- so this is not an edge case (NIL-560; observed
    // three times over in v0.7.0-nilo.3).
    //
    // Dedupe on the sentence, not the PR number: two merges of the same PR and
    // two different PRs making the identical promise are both noise to a
    // reader. First occurrence wins, so the order stays chronological.
    if (seen.has(sentence)) continue;
    seen.add(sentence);
    if (bucket === "Added") added.push(sentence);
    else if (bucket === "Fixed") fixed.push(sentence);
    else changed.push(sentence);
  }

  return { added, fixed, changed, warnings, mergesScanned: merges.length };
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function ghJson(args) {
  return JSON.parse(execFileSync("gh", args, { encoding: "utf8" }));
}

function createLiveCollector({ repo }) {
  return {
    listMerges(range) {
      const log = git(["log", "--merges", "--format=%H%x00%s", range]);
      if (!log) return [];
      return log.split("\n").map((line) => {
        const [sha, subject] = line.split("\x00");
        return { sha, subject };
      });
    },
    getPrBody(prNumber) {
      return ghJson(["pr", "view", String(prNumber), "--repo", repo, "--json", "body"]).body;
    },
    getPrCommitSubjects(prNumber) {
      const commits = ghJson(["pr", "view", String(prNumber), "--repo", repo, "--json", "commits"]).commits;
      return (commits || []).map((commit) => commit.messageHeadline || "");
    },
  };
}

function main() {
  const repo = process.env.RELEASE_NOTES_REPO;
  const previousRef = process.env.RELEASE_NOTES_PREVIOUS_REF;
  const headRef = process.env.RELEASE_NOTES_HEAD_REF || "HEAD";
  if (!repo) throw new Error("RELEASE_NOTES_REPO is required (owner/name).");

  const adapter = createLiveCollector({ repo });
  const range = previousRef ? `${previousRef}..${headRef}` : headRef;
  const result = collect({
    listMerges: () => adapter.listMerges(range),
    getPrBody: adapter.getPrBody,
    getPrCommitSubjects: adapter.getPrCommitSubjects,
  });

  for (const warning of result.warnings) process.stderr.write(`SKIP  ${warning}\n`);
  process.stdout.write(renderNotesMarkdown(result));
}

module.exports = {
  categorize,
  collect,
  createLiveCollector,
  extractPrNumber,
  extractUserFacingSentence,
  renderNotesMarkdown,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
