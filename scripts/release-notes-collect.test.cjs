#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const collectorUnderTest =
  process.env.RELEASE_NOTES_COLLECTOR_UNDER_TEST ||
  path.join(__dirname, "release-notes-collect.cjs");
const {
  resolveDeliveries,
  categorize,
  categorizeBucket,
  classifyUserFacing,
  collect,
  collectMergedPullRequests,
  extractPrNumber,
  extractUserFacingSentence,
  renderNotesMarkdown,
  USER_FACING_STATUS,
} = require(collectorUnderTest);

// The real commit subjects of PR #138 (NIL-567, "Make Markdown files
// editable (Stage 1)"), fetched via `gh pr view 138 --json commits`. Zero
// conventionally-prefixed feat commits, three fix commits picked up along
// the way, four collect-branch merges -- a brand-new feature that the old
// commit-subject vote sorted as "Fixed" (NIL-577).
const PR_138_COMMIT_SUBJECTS = [
  "Implement durable Markdown editing",
  "fix(editor): avoid floating toolbar collisions",
  "Test runtime DSN injection guard",
  "fix(release): make collected PR discovery deterministic",
  "merge: release notes: deterministische PR-Zuordnung (NIL-574) (#140)",
  "merge: Bugsink: Laufzeit-DSN-Injektion abgesichert (NIL-509) (#139)",
  "merge: schwebende Leiste: Umschlag nach unten statt Klemmen (NIL-573)",
  "merge: Markdown-Dateien bearbeitbar, Stufe 1 (NIL-567) (#138)",
  "fix(markdown): keep duplicated widgets on one revision",
];

test("extractPrNumber takes the last #NNN in a merge subject", () => {
  assert.equal(
    extractPrNumber("merge: dashboard presence, provenance and favorites (NIL-501, #75)"),
    75,
  );
  assert.equal(
    extractPrNumber("Merge pull request #42 from davifernan/fix/nil-321-operations-guardrails"),
    42,
  );
  assert.equal(extractPrNumber("no pr number here"), null);
});

test("categorize picks the majority conventional prefix, and ties go to Changed", () => {
  assert.equal(categorize(["feat(dashboard): add favorites", "feat(dashboard): star UI"]), "Added");
  assert.equal(
    categorize(["fix(editor): protect the real label", "fix(authz): route through grants"]),
    "Fixed",
  );
  assert.equal(categorize(["feat(a): x", "fix(a): y", "fix(a): z"]), "Fixed");
  assert.equal(categorize(["feat(a): x", "fix(a): y"]), "Changed");
  assert.equal(categorize(["chore: bump deps", "refactor: rename thing"]), "Changed");
  assert.equal(categorize([]), "Changed");
});

test("RED (NIL-577 bug, unrepaired path): the commit-subject vote alone sorts PR #138's real feature under Fixed", () => {
  // This is exactly what shipped in v0.9.0's draft: zero feat commits beat
  // three fix commits, so a brand-new feature was announced as a repair.
  // categorize() stays this way on purpose -- it is now only the legacy
  // fallback categorizeBucket() reaches for a PR merged before Change-Kind
  // existed -- so this assertion documents the bug it exists to route around,
  // it is not something to "fix" here.
  assert.equal(categorize(PR_138_COMMIT_SUBJECTS), "Fixed");
});

test("categorizeBucket reads the real PR #138 body's Change-Kind and reports Added, ignoring the misleading commit history (NIL-577)", () => {
  const body = [
    "Multica-Package: NIL-567",
    "Delivery-Slices: none",
    "Package-Session: 00000000-0000-4000-8000-000000000000",
    "Impact-Manifest: generated from git diff",
    "Visual-Evidence: provided",
    "User-Facing: Markdown files can now be edited directly in the browser.",
    "Change-Kind: added",
  ].join("\n");

  assert.equal(categorizeBucket(body, PR_138_COMMIT_SUBJECTS), "Added");
});

test("categorizeBucket falls back to the commit-subject vote when Change-Kind is absent (a pre-NIL-577 PR)", () => {
  const bodyWithoutChangeKind = [
    "Multica-Package: NIL-567",
    "User-Facing: Markdown files can now be edited directly in the browser.",
  ].join("\n");

  assert.equal(categorizeBucket(bodyWithoutChangeKind, PR_138_COMMIT_SUBJECTS), "Fixed");
  assert.equal(categorizeBucket("", PR_138_COMMIT_SUBJECTS), "Fixed");
});

test("categorizeBucket ignores an unrecognized Change-Kind value rather than trusting a malformed field", () => {
  const malformed = "Change-Kind: feature\nUser-Facing: whatever";
  assert.equal(categorizeBucket(malformed, PR_138_COMMIT_SUBJECTS), "Fixed");
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

// NIL-594: the real bug was two `User-Facing:` lines in one PR body (#150,
// NIL-580) silently vanishing behind the same "missing, malformed, or none"
// warning every intentional skip in the same run also printed. These pin
// down that classifyUserFacing() tells the accident apart from the decision.
test("classifyUserFacing: a real sentence classifies as ok", () => {
  const classified = classifyUserFacing("User-Facing: Boards can now be starred.");
  assert.equal(classified.status, USER_FACING_STATUS.OK);
  assert.equal(classified.sentence, "Boards can now be starred.");
  assert.equal(classified.reason, null);
});

test("classifyUserFacing: User-Facing: none is a decision, not a suspect case", () => {
  const classified = classifyUserFacing("User-Facing: none");
  assert.equal(classified.status, USER_FACING_STATUS.NONE);
  assert.equal(classified.sentence, null);
});

test("classifyUserFacing: a missing line is a suspect case with its own reason", () => {
  const classified = classifyUserFacing("no such line at all");
  assert.equal(classified.status, USER_FACING_STATUS.MISSING);
  assert.match(classified.reason, /no `User-Facing:` line found/);
});

test("classifyUserFacing: a duplicated field names the count literally, the actual v0.11.0/#150 shape", () => {
  // The real PR #150 body: the contract header's line, then the same
  // sentence repeated (wrapped) further down in prose.
  const body = [
    "User-Facing: Sticky note text now shrinks smoothly as you type.",
    "",
    "Some other section repeats the promise for readability:",
    "User-Facing: Sticky note text now shrinks smoothly as you type.",
  ].join("\n");
  const classified = classifyUserFacing(body);
  assert.equal(classified.status, USER_FACING_STATUS.DUPLICATED);
  assert.match(classified.reason, /2 `User-Facing:` lines found/);
});

test("classifyUserFacing: a present but empty line is malformed, not treated as none", () => {
  const classified = classifyUserFacing("User-Facing:   ");
  assert.equal(classified.status, USER_FACING_STATUS.MALFORMED);
  assert.match(classified.reason, /present but empty/);
});

test("collect: a duplicated User-Facing field surfaces as a warning naming the duplication literally", () => {
  const result = collect({
    listDeliveries: () => [{ sha: "1".repeat(40), subject: "merge: sticky notes (NIL-580, #150)" }],
    getPrBody: () =>
      [
        "User-Facing: Sticky note text now shrinks smoothly as you type.",
        "User-Facing: Sticky note text now shrinks smoothly as you type.",
      ].join("\n"),
    getPrCommitSubjects: () => [],
  });
  assert.deepEqual(result.added.length + result.fixed.length + result.changed.length, 0);
  assert.deepEqual(result.skippedByDesign, []);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /#150/);
  assert.match(result.warnings[0], /2 `User-Facing:` lines found/);
});

test("collect: User-Facing: none produces no warning, only a calm skippedByDesign entry", () => {
  const result = collect({
    listDeliveries: () => [{ sha: "2".repeat(40), subject: "merge: internal only (#157)" }],
    getPrBody: () => "User-Facing: none",
    getPrCommitSubjects: () => [],
  });
  assert.deepEqual(result.warnings, []);
  assert.equal(result.skippedByDesign.length, 1);
  assert.match(result.skippedByDesign[0], /#157/);
});

test("collect: a run where every skip is User-Facing: none produces zero warnings, not one per skip", () => {
  const deliveries = Array.from({ length: 7 }, (_, i) => ({
    sha: `${i}`.repeat(40),
    subject: `merge: internal change ${i} (#${200 + i})`,
  }));
  const result = collect({
    listDeliveries: () => deliveries,
    getPrBody: () => "User-Facing: none",
    getPrCommitSubjects: () => [],
  });
  assert.equal(
    result.warnings.length,
    0,
    "no warning at all when every skip was a decision, not an accident",
  );
  assert.equal(result.skippedByDesign.length, 7);
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

test("collect walks deliveries, skips what it can't use, and never fabricates a sentence", () => {
  const deliveries = [
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
    listDeliveries: () => deliveries,
    getPrBody: (n) => {
      if (n === 12) throw new Error("gh: pull request not found");
      return bodies[n];
    },
    getPrCommitSubjects: (n) => commits[n] || [],
  });

  assert.deepEqual(result.added, ["Boards can now be starred from the dashboard."]);
  assert.deepEqual(result.fixed, []);
  assert.deepEqual(result.changed, []);
  assert.equal(result.deliveriesScanned, 4);
  // NIL-594: #11's intentional `User-Facing: none` is not a warning -- it's
  // the one entry in skippedByDesign. Only genuinely broken deliveries
  // (no PR number, an unfetchable body) remain in warnings.
  assert.equal(result.warnings.length, 2);
  assert.equal(result.skippedByDesign.length, 1);
  assert.match(result.skippedByDesign[0], /#11/);
  assert.match(
    result.warnings.find((w) => w.includes("no PR number")),
    /no PR number/,
  );
  assert.match(
    result.warnings.find((w) => w.includes("#12")),
    /could not fetch/,
  );
});

test("end to end: collect() sorts PR #138's real delivery under Added via its Change-Kind, not its misleading commit history (NIL-577)", () => {
  const sentence = "Markdown files can now be edited directly in the browser.";
  const bodyWithChangeKind = ["User-Facing: " + sentence, "Change-Kind: added"].join("\n");

  const result = collect({
    listDeliveries: () => [
      {
        sha: "1".repeat(40),
        subject: "merge: Markdown-Dateien bearbeitbar, Stufe 1 (NIL-567) (#138)",
      },
    ],
    getPrBody: () => bodyWithChangeKind,
    getPrCommitSubjects: () => PR_138_COMMIT_SUBJECTS,
  });

  assert.deepEqual(result.added, [sentence]);
  assert.deepEqual(result.fixed, []);
});

test("RED: a PR whose User-Facing line contains a ticket reference never reaches this collector in the first place -- the contract check rejects it at admission (scripts/delivery-v2.test.cjs), so collect() cannot see or launder one", () => {
  // Documents the boundary: this file only proves collect() does not invent
  // text on its own. The no-ticket-numbers rule is enforced upstream, once,
  // in parsePrDeliveryContract -- duplicating that regex here would let the
  // two checks drift apart instead of sharing one source of truth.
  const result = collect({
    listDeliveries: () => [{ sha: "5".repeat(40), subject: "merge: whatever (#20)" }],
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
    listDeliveries: () => [
      { sha: "a".repeat(40), subject: "merge: #116 (fix/oversized)" },
      { sha: "b".repeat(40), subject: "merge: #120 (collect/wave-6)" },
      { sha: "c".repeat(40), subject: "merge: #121 (fix/oversized-followup)" },
    ],
    getPrBody: () => `User-Facing: ${sentence}`,
    getPrCommitSubjects: () => ["fix(editor): whatever"],
  });
  assert.deepEqual(result.fixed, [sentence]);
  assert.equal(
    result.deliveriesScanned,
    3,
    "all three deliveries are still scanned, only the output is folded",
  );
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
    listDeliveries: () => [
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
  const deliveries = resolveDeliveries({
    listCommitShas: () => ["aaa", "bbb", "ccc"],
    listMergedPullRequests: () => [
      { number: 124, mergeCommitSha: "aaa" },
      { number: 124, mergeCommitSha: "bbb" },
      { number: 122, mergeCommitSha: "ccc" },
    ],
  });
  assert.deepEqual(
    deliveries.map((d) => d.subject),
    ["#124", "#122"],
  );
});

test("commits without a merged PR record are skipped, not fatal", () => {
  // Direct hotfixes and commits older than the PR history both hit this.
  const deliveries = resolveDeliveries({
    listCommitShas: () => ["good", "orphan"],
    listMergedPullRequests: () => [{ number: 7, mergeCommitSha: "good" }],
  });
  assert.deepEqual(
    deliveries.map((d) => d.subject),
    ["#7"],
  );
});

test("merged PR pagination stops after crossing the previous release without missing that page", () => {
  const pagesRead = [];
  const pages = {
    1: [
      {
        number: 12,
        mergeCommitSha: "new",
        mergedAt: "2026-08-25T10:00:00Z",
        updatedAt: "2026-08-25T10:10:00Z",
      },
      { number: 11, mergeCommitSha: null, mergedAt: null, updatedAt: "2026-08-25T09:30:00Z" },
    ],
    2: [
      {
        number: 10,
        mergeCommitSha: "edge",
        mergedAt: "2026-08-25T09:05:00Z",
        updatedAt: "2026-08-25T09:06:00Z",
      },
      {
        number: 9,
        mergeCommitSha: "old",
        mergedAt: "2026-08-25T08:00:00Z",
        updatedAt: "2026-08-25T08:30:00Z",
      },
    ],
    3: [
      {
        number: 8,
        mergeCommitSha: "older",
        mergedAt: "2026-08-24T08:00:00Z",
        updatedAt: "2026-08-24T08:30:00Z",
      },
    ],
  };
  const pulls = collectMergedPullRequests({
    updatedAfter: "2026-08-25T09:00:00Z",
    pageSize: 2,
    readPage: (page) => {
      pagesRead.push(page);
      return pages[page] || [];
    },
  });

  assert.deepEqual(pagesRead, [1, 2], "the first wholly older continuation page is never fetched");
  assert.deepEqual(
    pulls.map((pull) => pull.number),
    [12, 10, 9],
  );
});

test("the real v0.8.0 collected merge resolves every PR, including #134 (NIL-574)", () => {
  const range = "v0.7.0-nilo.4..v0.8.0";
  const collectedMerge = "99a03699635d6c66eb02e88a989104a7441c64e6";
  // Immutable capture of the real `git log --reverse --topo-order` range.
  // The optional live counterprobe revalidates it against GitHub; required
  // CI stays hermetic so deleting an old tag or editing an old PR cannot
  // block an unrelated future change.
  const commits = [
    "f9ee8017d1a314f80c7454422f7214e517358b3e",
    "4ea8680ff5c0bc7500cbbfc6f8b810b58d3e8d40",
    "c612f436e0434933b85de106e4864a94e9932e7e",
    "769315fdbe566e172c2ae9907dad593ab7a74a55",
    "5a963170d57223553096dbea3e6661e54cda27ef",
    "0aa4721b289eae4c365b718af42fa4c163cf742f",
    "5db814db1afaac34ed575ea6b8b1abe711d430b0",
    "b0bca98ccb1294473c03c08fed00602a0a9ad65d",
    "7517438e284d2c2090c2e30ee69a50972c8a0c00",
    "169e8a7b96e5884abd8c3cea9e8326eac9cf5d5b",
    "7d3159f4b4728b67cbb3cc07e0e91b4483778698",
    "6157e360b660a90b54eab4ad776a07d0d93f5910",
    "848df03725aa1730c7d3705a88b757a9bd7d5c77",
    "b578fba4e0880816df1a715ad30f9b870f56485e",
    "82d8a4a50922e3cb2c1efd03c4893a51529204db",
    "3fd54d673a66a8494122d38c4ea93517a97600bf",
    "27736060e67cab0ec98251875bdca658713832c7",
    "eb0158ebd1dee1c520dc72f5eacdcef344789925",
    collectedMerge,
  ];

  assert.ok(
    commits.includes(collectedMerge),
    `${range} must contain the real collected merge 99a0369`,
  );

  // These are the canonical merge_commit_sha values on the real PR records.
  // #132 and #134 deliberately share one SHA; that is the production shape
  // the old commit->associated-PR lookup could not represent reliably.
  const deliveries = resolveDeliveries({
    listCommitShas: () => commits,
    listMergedPullRequests: () => [
      { number: 135, mergeCommitSha: "3fd54d673a66a8494122d38c4ea93517a97600bf" },
      { number: 134, mergeCommitSha: collectedMerge },
      { number: 132, mergeCommitSha: collectedMerge },
    ],
  });

  assert.deepEqual(
    deliveries
      .filter((delivery) => delivery.sha === collectedMerge)
      .map((delivery) => delivery.subject),
    ["#132", "#134"],
  );
});
