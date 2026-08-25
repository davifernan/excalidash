#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  resolveDeliveries,
  categorize,
  collect,
  extractPrNumber,
  extractUserFacingSentence,
  renderNotesMarkdown,
} = require("./release-notes-collect.cjs");

test("extractPrNumber takes the last #NNN in a merge subject", () => {
  assert.equal(extractPrNumber("merge: dashboard presence, provenance and favorites (NIL-501, #75)"), 75);
  assert.equal(extractPrNumber("Merge pull request #42 from davifernan/fix/nil-321-operations-guardrails"), 42);
  assert.equal(extractPrNumber("no pr number here"), null);
});

test("categorize picks the majority conventional prefix, and ties go to Changed", () => {
  assert.equal(categorize(["feat(dashboard): add favorites", "feat(dashboard): star UI"]), "Added");
  assert.equal(categorize(["fix(editor): protect the real label", "fix(authz): route through grants"]), "Fixed");
  assert.equal(categorize(["feat(a): x", "fix(a): y", "fix(a): z"]), "Fixed");
  assert.equal(categorize(["feat(a): x", "fix(a): y"]), "Changed");
  assert.equal(categorize(["chore: bump deps", "refactor: rename thing"]), "Changed");
  assert.equal(categorize([]), "Changed");
});

test("extractUserFacingSentence returns the sentence, and null for none/missing/malformed", () => {
  assert.equal(
    extractUserFacingSentence("User-Facing: Boards can now be starred."),
    "Boards can now be starred.",
  );
  assert.equal(extractUserFacingSentence("User-Facing: none"), null);
  assert.equal(extractUserFacingSentence("no such line at all"), null);
  assert.equal(
    extractUserFacingSentence("User-Facing: one\nUser-Facing: two"),
    null,
    "a duplicated field is ambiguous, not a value to pick from",
  );
});

test("RED: extractUserFacingSentence never invents text -- an unparseable body yields nothing, not a guess", () => {
  assert.equal(extractUserFacingSentence(""), null);
  assert.equal(extractUserFacingSentence(undefined), null);
});

test("renderNotesMarkdown groups by bucket and omits empty groups", () => {
  const markdown = renderNotesMarkdown({
    added: ["Boards can now be starred."],
    fixed: ["Fixed a crash on empty boards."],
    changed: [],
  });
  assert.match(markdown, /### Added/);
  assert.match(markdown, /- Boards can now be starred\./);
  assert.match(markdown, /### Fixed/);
  assert.doesNotMatch(markdown, /### Changed/);
});

test("renderNotesMarkdown says so honestly when nothing was collected", () => {
  const markdown = renderNotesMarkdown({ added: [], fixed: [], changed: [] });
  assert.match(markdown, /No `User-Facing:` entries were collected/);
});

test("collect walks merges, skips what it can't use, and never fabricates a sentence", () => {
  const merges = [
    { sha: "1".repeat(40), subject: "merge: add favorites (NIL-292, #10)" },
    { sha: "2".repeat(40), subject: "merge: internal refactor only (NIL-300, #11)" },
    { sha: "3".repeat(40), subject: "merge: no pr number in this one" },
    { sha: "4".repeat(40), subject: "merge: fetch fails (NIL-301, #12)" },
  ];
  const bodies = {
    10: "User-Facing: Boards can now be starred from the dashboard.",
    11: "User-Facing: none",
  };
  const commits = {
    10: ["feat(dashboard): add favorites backend", "feat(dashboard): star UI"],
  };

  const result = collect({
    listMerges: () => merges,
    getPrBody: (n) => {
      if (n === 12) throw new Error("gh: pull request not found");
      return bodies[n];
    },
    getPrCommitSubjects: (n) => commits[n] || [],
  });

  assert.deepEqual(result.added, ["Boards can now be starred from the dashboard."]);
  assert.deepEqual(result.fixed, []);
  assert.deepEqual(result.changed, []);
  assert.equal(result.mergesScanned, 4);
  assert.equal(result.warnings.length, 3);
  assert.match(result.warnings.find((w) => w.includes("#11")), /"none"/);
  assert.match(result.warnings.find((w) => w.includes("no PR number")), /no PR number/);
  assert.match(result.warnings.find((w) => w.includes("#12")), /could not fetch/);
});

test("RED: a PR whose User-Facing line contains a ticket reference never reaches this collector in the first place -- the contract check rejects it at admission (scripts/delivery-v2.test.cjs), so collect() cannot see or launder one", () => {
  // Documents the boundary: this file only proves collect() does not invent
  // text on its own. The no-ticket-numbers rule is enforced upstream, once,
  // in parsePrDeliveryContract -- duplicating that regex here would let the
  // two checks drift apart instead of sharing one source of truth.
  const result = collect({
    listMerges: () => [{ sha: "5".repeat(40), subject: "merge: whatever (#20)" }],
    getPrBody: () => "User-Facing: Fixes the bug from NIL-292.",
    getPrCommitSubjects: () => [],
  });
  // collect() is deliberately not the enforcement point: it copies whatever
  // string is present. This assertion pins that division of labor down so a
  // future change cannot silently start "fixing up" text here instead.
  assert.deepEqual(result.added.length + result.fixed.length + result.changed.length, 1);
});

test("the same User-Facing sentence merged several times appears once (NIL-560)", () => {
  // Our merge path produces this on purpose: a delivery goes into a collect
  // branch, that branch is merged again, so `git log --merges` legitimately
  // sees the same promise more than once. v0.7.0-nilo.3 shipped with one
  // sentence printed three times before this was fixed.
  const sentence = "Oversized images are named instead of hashed.";
  const result = collect({
    listMerges: () => [
      { sha: "a".repeat(40), subject: "merge: #116 (fix/oversized)" },
      { sha: "b".repeat(40), subject: "merge: #120 (collect/wave-6)" },
      { sha: "c".repeat(40), subject: "merge: #121 (fix/oversized-followup)" },
    ],
    getPrBody: () => `User-Facing: ${sentence}`,
    getPrCommitSubjects: () => ["fix(editor): whatever"],
  });
  assert.deepEqual(result.fixed, [sentence]);
  assert.equal(result.mergesScanned, 3, "all three merges are still scanned, only the output is folded");
});

test("deduping folds repeats, it does not drop distinct promises", () => {
  // The counter-direction: a dedupe that is too eager would swallow real
  // entries. Three merges, two distinct sentences -> two lines, in order.
  const first = "Selections survive a background refresh.";
  const second = "Page turns survive going offline.";
  const bodies = {
    1: `User-Facing: ${first}`,
    2: `User-Facing: ${second}`,
    3: `User-Facing: ${first}`,
  };
  const result = collect({
    listMerges: () => [
      { sha: "d".repeat(40), subject: "merge: x (#1)" },
      { sha: "e".repeat(40), subject: "merge: y (#2)" },
      { sha: "f".repeat(40), subject: "merge: z (#3)" },
    ],
    getPrBody: (pr) => bodies[pr],
    getPrCommitSubjects: () => ["fix(app): whatever"],
  });
  assert.deepEqual(result.fixed, [first, second]);
});

test("a range with no merge commits at all still yields its deliveries (NIL-562)", () => {
  // v0.7.0-nilo.4 shipped with empty notes: six commits, zero merge commits,
  // because `main` was fast-forwarded. Fast-forward is the normal path here --
  // it is the only way a SHA carrying nine green required checks reaches
  // `main` without creating a fresh unverified commit.
  const prByCommit = { aaa: [124], bbb: [124], ccc: [122] };
  const deliveries = resolveDeliveries({
    listCommitShas: () => ["aaa", "bbb", "ccc"],
    resolvePrNumbers: (sha) => prByCommit[sha],
  });
  assert.deepEqual(deliveries.map((d) => d.subject), ["#124", "#122"]);
});

test("a commit whose PR cannot be resolved is skipped, not fatal", () => {
  // Direct hotfixes and commits older than the PR history both hit this.
  // The merge-based scan simply never saw them; the replacement must not
  // turn "no PR" into a crashed release.
  const deliveries = resolveDeliveries({
    listCommitShas: () => ["good", "orphan"],
    resolvePrNumbers: (sha) => {
      if (sha === "orphan") throw new Error("no pull requests found");
      return [7];
    },
  });
  assert.deepEqual(deliveries.map((d) => d.subject), ["#7"]);
});
