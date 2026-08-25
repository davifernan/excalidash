#!/usr/bin/env node
/**
 * Collects release notes from the `User-Facing:` line every PR contract now
 * requires (scripts/delivery-v2.cjs, NIL-507) -- it never writes prose of its
 * own. The only thing this script formulates is which of three buckets
 * (Added / Fixed / Changed) a collected sentence goes under; the sentence
 * itself is always the implementer's own words, copied verbatim.
 *
 * The bucket itself also comes from the contract, not a guess: `Change-Kind:`
 * (delivery-v2.cjs, NIL-577) is the implementer's own declaration, read by
 * `categorizeBucket()`. The commit-subject vote in `categorize()` only fires
 * as a fallback for a PR merged before that field existed -- see its own
 * comment for why voting on commit subjects mis-sorted a real feature PR.
 *
 * Why at tag time and not per-merge: Davi's framing (24.08.2026) is that the
 * only person who reliably knows what a user will notice is the implementer,
 * at the moment they open the PR -- so the contract captures it there. But
 * *assembling* those lines into one release's notes has to happen once, over
 * the whole range since the previous release, which is only knowable when
 * the release actually happens.
 *
 * Adapter split (same shape as pipeline-sentinel.cjs's createLiveAdapter):
 * `collect()` takes injected `listDeliveries`/`getPrBody` functions so the
 * grouping and rendering logic can be tested without a real repository or
 * `gh` credentials. `createLiveCollector()` wires the real `git`/`gh` calls
 * for the CLI entry point used by .github/workflows/release.yml.
 */

"use strict";

const { execFileSync } = require("node:child_process");
const { CHANGE_KIND, fieldValues, USER_FACING_NONE } = require("./delivery-v2.cjs");

const BUCKET_BY_CHANGE_KIND = Object.freeze({
  [CHANGE_KIND.ADDED]: "Added",
  [CHANGE_KIND.FIXED]: "Fixed",
  [CHANGE_KIND.CHANGED]: "Changed",
});

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
 * what ships.
 *
 * LEGACY FALLBACK ONLY (NIL-577): this measures how a branch was built, not
 * what it is for a user, and both drift the longer a branch lives. PR #138
 * (NIL-567, a brand-new Markdown editor) carried zero conventionally-prefixed
 * feat commits and three incidental fix commits, so this voted "Fixed" for a
 * feature. `categorizeBucket()` below only reaches this function for PRs
 * merged before the `Change-Kind:` contract field existed; every PR since
 * declares its bucket directly and this vote is never consulted. */
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

/** The real bucket source: the PR's own `Change-Kind:` declaration
 * (delivery-v2.cjs's parsePrDeliveryContract already validates it to one of
 * added/fixed/changed/none whenever the contract is well-formed). Falls back
 * to the commit-subject vote only for a PR merged before this field existed
 * -- a malformed or missing field on a *current* PR should not silently
 * mis-sort it, but historical release ranges must still collect. */
function categorizeBucket(body, commitSubjects) {
  const values = fieldValues(body || "", "Change-Kind");
  if (values.length === 1 && values[0] in BUCKET_BY_CHANGE_KIND) {
    return BUCKET_BY_CHANGE_KIND[values[0]];
  }
  return categorize(commitSubjects);
}

/** The reasons `classifyUserFacing()` can report. `NONE` is a decision --
 * the implementer wrote `User-Facing: none` on purpose, and skipping it is
 * the correct, unremarkable outcome. The other three are all "something is
 * wrong with this field", never a decision anyone made on purpose:
 * `MISSING` (no line at all), `DUPLICATED` (more than one -- ambiguous,
 * `collect()` cannot pick a winner), `MALFORMED` (a line present but empty,
 * neither a sentence nor the literal `none` marker). */
const USER_FACING_STATUS = Object.freeze({
  OK: "ok",
  NONE: "none",
  MISSING: "missing",
  DUPLICATED: "duplicated",
  MALFORMED: "malformed",
});

/**
 * Classifies a PR body's `User-Facing:` field into exactly one reason
 * (NIL-594) instead of collapsing every non-usable case into the same bare
 * `null` `extractUserFacingSentence()` used to return everywhere.
 *
 * The distinction this exists for: v0.11.0 silently dropped a real entry
 * (#150, NIL-580) because its body had the field twice -- once in the
 * contract header, once repeated further down -- and the collector's own
 * warning read identically to the seven other, entirely intentional
 * `User-Facing: none` skips in the same run. A warning that fires on every
 * release and is almost always noise does not get read; `collect()` uses
 * `status` to only ever surface the reasons that are actually suspect.
 */
function classifyUserFacing(body) {
  const values = fieldValues(body || "", "User-Facing");
  if (values.length === 0) {
    return {
      status: USER_FACING_STATUS.MISSING,
      sentence: null,
      reason: "no `User-Facing:` line found",
    };
  }
  if (values.length > 1) {
    return {
      status: USER_FACING_STATUS.DUPLICATED,
      sentence: null,
      reason: `${values.length} \`User-Facing:\` lines found`,
    };
  }
  const trimmed = values[0].trim();
  if (trimmed === USER_FACING_NONE) {
    return { status: USER_FACING_STATUS.NONE, sentence: null, reason: null };
  }
  if (trimmed.length === 0) {
    return {
      status: USER_FACING_STATUS.MALFORMED,
      sentence: null,
      reason: "`User-Facing:` line is present but empty",
    };
  }
  return { status: USER_FACING_STATUS.OK, sentence: trimmed, reason: null };
}

/** Extracts the User-Facing line without requiring the rest of the contract
 * to be well-formed -- unlike parsePrDeliveryContract, a malformed or
 * pre-contract PR body must not crash the whole collection run. Returns null
 * when nothing usable is present (missing, duplicated, or `none`). Thin
 * wrapper over `classifyUserFacing()` -- see that function for why "none"
 * and everything else both landing here as a bare `null` is exactly the
 * problem NIL-594 fixes one layer up, in `collect()`'s warning output. */
function extractUserFacingSentence(body) {
  const classified = classifyUserFacing(body);
  return classified.status === USER_FACING_STATUS.OK ? classified.sentence : null;
}

function renderGroup(title, entries) {
  if (entries.length === 0) return "";
  return `### ${title}\n\n${entries.map((entry) => `- ${entry}`).join("\n")}\n`;
}

/** Renders only the body groups (Added/Fixed/Changed) -- the surrounding
 * version heading and upgrade-steps boilerplate are the human's job when
 * polishing the draft, per docs/architecture/RELEASE_PROCESS.md. */
function renderNotesMarkdown({ added = [], fixed = [], changed = [] }) {
  const groups = [
    renderGroup("Added", added),
    renderGroup("Fixed", fixed),
    renderGroup("Changed", changed),
  ].filter(Boolean);
  if (groups.length === 0) {
    return "_No `User-Facing:` entries were collected for this range -- every merged package in it declared `User-Facing: none`, or none had a recognized contract yet. Verify this is expected before publishing._\n";
  }
  return groups.join("\n");
}

/**
 * Walks the PR deliveries resolved for `previousRef..headRef` and asks the
 * injected adapter for each PR's body and commit subjects. Skips (with a
 * warning, not a failure) any delivery
 * that yields no PR number or no fetchable body -- an incomplete note is a
 * smaller failure than an aborted release, and the draft is reviewed by a
 * human before it goes out.
 *
 * A skipped `User-Facing:` field is not one bucket, per NIL-594:
 * `skippedByDesign` holds `User-Facing: none` decisions -- expected,
 * unremarkable, never printed as a warning by `main()`. `warnings` holds
 * everything else that made this delivery unusable, each with the concrete
 * reason (`classifyUserFacing()`'s `reason`) rather than the old one-size
 * "missing, malformed, or none" line that read identically for an
 * intentional skip and an accident (v0.11.0's #150, NIL-580: two
 * `User-Facing:` lines in one body silently dropped a real entry, and nothing
 * in the log distinguished it from the run's seven genuine `none`s).
 */
function collect({ listDeliveries, getPrBody, getPrCommitSubjects }) {
  const deliveries = listDeliveries();
  const added = [];
  const fixed = [];
  const changed = [];
  const warnings = [];
  const skippedByDesign = [];
  const seen = new Set();

  for (const delivery of deliveries) {
    const prNumber = extractPrNumber(delivery.subject);
    if (prNumber === null) {
      warnings.push(
        `${delivery.sha.slice(0, 12)}: no PR number found in "${delivery.subject}", skipped`,
      );
      continue;
    }

    let body;
    try {
      body = getPrBody(prNumber);
    } catch (error) {
      warnings.push(`#${prNumber}: could not fetch PR body (${error.message}), skipped`);
      continue;
    }

    const classified = classifyUserFacing(body);
    if (classified.status === USER_FACING_STATUS.NONE) {
      skippedByDesign.push(`#${prNumber}: User-Facing: none`);
      continue;
    }
    if (classified.status !== USER_FACING_STATUS.OK) {
      warnings.push(`#${prNumber}: User-Facing field is unusable -- ${classified.reason}, skipped`);
      continue;
    }
    const sentence = classified.sentence;

    const subjects = getPrCommitSubjects(prNumber, delivery);
    const bucket = categorizeBucket(body, subjects);
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

  return { added, fixed, changed, warnings, skippedByDesign, deliveriesScanned: deliveries.length };
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function ghJson(args) {
  return JSON.parse(execFileSync("gh", args, { encoding: "utf8" }));
}

function ghLines(args) {
  const output = execFileSync("gh", args, { encoding: "utf8" }).trim();
  return output ? output.split("\n") : [];
}

/**
 * Resolves the PRs that cover a commit range, in commit order, deduplicated.
 *
 * Deliberately NOT driven by merge commits. A merge commit is not a reliable
 * index of a delivery here, in either direction (NIL-560, NIL-562):
 *
 *   collect branch  -> several merges carry the same delivery -> duplicates
 *   fast-forward    -> no merge commit at all                 -> nothing
 *
 * Fast-forward is the normal path, not an exception: it is the only way a SHA
 * that already carries nine green required checks reaches `main` without
 * creating a fresh, unverified commit. `v0.7.0-nilo.4` shipped with empty
 * notes because of exactly this.
 *
 * The direction of the lookup matters. GitHub's
 * `GET repos/{repo}/commits/{sha}/pulls` is an association search, not a
 * stable delivery record: when several PRs are collected into one branch
 * and that branch reaches `main` as one SHA, repeated calls can associate
 * different PRs with the commits. That made two v0.8.0 collection runs
 * disagree and silently omitted #134 once (NIL-574).
 *
 * The PR record has the canonical relation in the other direction:
 * `merge_commit_sha`. GitHub records the same collected SHA on every PR in
 * the batch (#132 and #134 both point at 99a0369), so intersecting all
 * merged PR records with the local range is complete and deterministic.
 * PR number is the stable tie-breaker when several PRs share one SHA.
 *
 * Split out from the live adapter so both the exact v0.8.0 history and the
 * ordering rule can be tested without making every unit test depend on `gh`.
 */
function resolveDeliveries({ listCommitShas, listMergedPullRequests }) {
  const commitOrder = new Map(listCommitShas().map((sha, index) => [sha, index]));
  const seen = new Set();
  const deliveries = (listMergedPullRequests() || [])
    .filter((pull) => commitOrder.has(pull.mergeCommitSha))
    .sort(
      (left, right) =>
        commitOrder.get(left.mergeCommitSha) - commitOrder.get(right.mergeCommitSha) ||
        left.number - right.number,
    )
    .filter((pull) => {
      if (seen.has(pull.number)) return false;
      seen.add(pull.number);
      return true;
    })
    .map((pull) => ({
      sha: pull.mergeCommitSha,
      subject: `#${pull.number}`,
    }));

  return deliveries;
}

function collectMergedPullRequests({ readPage, updatedAfter = null, pageSize = 100 }) {
  const cutoff = updatedAfter === null ? null : Date.parse(updatedAfter);
  if (updatedAfter !== null && !Number.isFinite(cutoff)) {
    throw new Error(`Invalid merged-PR updatedAfter value: ${updatedAfter}`);
  }

  const merged = [];
  for (let page = 1; ; page += 1) {
    const pulls = readPage(page);
    for (const pull of pulls) {
      if (!pull.mergedAt || !pull.mergeCommitSha) continue;
      merged.push({ number: pull.number, mergeCommitSha: pull.mergeCommitSha });
    }

    if (pulls.length < pageSize) break;
    const oldestUpdated = Date.parse(pulls[pulls.length - 1].updatedAt);
    if (!Number.isFinite(oldestUpdated)) {
      throw new Error(`GitHub returned an invalid pull-request updated_at on page ${page}.`);
    }
    // The endpoint is ordered by updated_at descending. A PR's updated_at is
    // never earlier than its merged_at, so after this page falls behind the
    // previous release commit, no later page can contain a PR merged into the
    // new range. Old PRs edited recently remain on an earlier page and are
    // harmlessly filtered by merge_commit_sha afterward.
    if (cutoff !== null && oldestUpdated < cutoff) break;
  }
  return merged;
}

function listMergedPullRequests(repo, updatedAfter) {
  return collectMergedPullRequests({
    updatedAfter,
    readPage(page) {
      // Project only the required fields before `gh` writes stdout. A full
      // page of PR bodies can exceed Node's execFileSync buffer.
      return ghLines([
        "api",
        `repos/${repo}/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100&page=${page}`,
        "--jq",
        ".[] | [.number, .merge_commit_sha, .merged_at, .updated_at] | @tsv",
      ]).map((line) => {
        const [number, mergeCommitSha, mergedAt, updatedAt] = line.split("\t");
        return {
          number: Number(number),
          mergeCommitSha: mergeCommitSha || null,
          mergedAt: mergedAt || null,
          updatedAt,
        };
      });
    },
  });
}

function createLiveCollector({ repo }) {
  return {
    listDeliveries(range) {
      const separator = range.indexOf("..");
      const previousRef = separator === -1 ? null : range.slice(0, separator);
      const updatedAfter = previousRef ? git(["log", "-1", "--format=%cI", previousRef]) : null;
      return resolveDeliveries({
        listCommitShas: () => {
          const log = git(["log", "--reverse", "--topo-order", "--format=%H", range]);
          return log ? log.split("\n").filter(Boolean) : [];
        },
        listMergedPullRequests: () => listMergedPullRequests(repo, updatedAfter),
      });
    },
    getPrBody(prNumber) {
      return ghJson(["pr", "view", String(prNumber), "--repo", repo, "--json", "body"]).body;
    },
    getPrCommitSubjects(prNumber) {
      const commits = ghJson([
        "pr",
        "view",
        String(prNumber),
        "--repo",
        repo,
        "--json",
        "commits",
      ]).commits;
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
    listDeliveries: () => adapter.listDeliveries(range),
    getPrBody: adapter.getPrBody,
    getPrCommitSubjects: adapter.getPrCommitSubjects,
  });

  // Two severities, not one (NIL-594): a `User-Facing: none` skip is a
  // decision, printed calmly and never as SUSPECT -- and when every skip in
  // the run is one of these, nothing below prints at all. Everything in
  // `warnings` is something actually wrong with a delivery (no PR number, an
  // unfetchable body, or a User-Facing field that is missing, duplicated, or
  // malformed) and prints as SUSPECT with its own concrete reason, never
  // folded into a single "missing, malformed, or none" line that reads the
  // same for an accident and seven intentional skips in the same run.
  for (const note of result.skippedByDesign) process.stderr.write(`NOTE     ${note}\n`);
  for (const warning of result.warnings) process.stderr.write(`SUSPECT  ${warning}\n`);
  process.stdout.write(renderNotesMarkdown(result));
}

module.exports = {
  categorize,
  categorizeBucket,
  classifyUserFacing,
  collect,
  collectMergedPullRequests,
  createLiveCollector,
  resolveDeliveries,
  extractPrNumber,
  extractUserFacingSentence,
  renderNotesMarkdown,
  USER_FACING_STATUS,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
