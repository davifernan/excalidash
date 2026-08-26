# Fix-verification records

Hans-Friedrich reviews one admitted PR head. A finding fix moves the head, so the resulting
`hans_sha..fix_sha` delta needs its own evidence without causing a second general review.
That evidence is a GitHub PR comment containing one `excalidash-fix-verification:v1` marker.
This is not just a style preference: `checkFixVerificationCoverage` (`scripts/
delivery-contracts.cjs`) treats a comment with more than one marker as invalid **in its
entirety**, not just the extra records. `parseFixVerificationMarker` throws on a second match,
and the catch increments `invalidRecords` for the whole comment -- none of its markers, including
an otherwise-correct one, ever reach `matchingRecords`. Two markers in one comment measured
`covered:false, invalidRecords:1`; the identical evidence split across two comments measured
`covered:true, invalidRecords:0`. One marker per comment, always.

The marker is a replay recipe, not an approval flag. It deliberately has no `verified: true`
field. A consumer can establish only that an exact SHA delta has a structurally valid,
attributed recipe; a human or controlled verifier can then rerun the recorded command and
compare the two recorded observations.

## Who writes the record

The delivery pipeline that once carried this out as a service is gone: the `PR Overseer Events`
workflow was removed on 2026-08-23, and the sentinel that chased fix deltas is switched off. The
procedure below is unchanged and is now carried out by hand. `pr-overseer` stays the recorded
role value -- it names the role performing the check, not a running service.

- Whoever holds the overseer role writes it after accepting objective red/green evidence and
  replaying or otherwise checking both observations.
- The Finding Verifier writes it when the expensive, narrow verification path was required.
- The Implementer may supply commands and raw observations in the fix handoff, but does not
  turn their own claim into a machine-covered delta.

Both producers use the same schema and identify their origin in `recorded_by`. The GitHub
comment author must match `recorded_by.actor` (case-insensitively). That binding records
provenance; it is not the reason the evidence is valid. The command, exact inputs, outputs,
and measurement identity make the record independently replayable.

## Marker schema

Every record has these common fields:

```json
{
  "schema": 1,
  "from_sha": "<40 lowercase hex characters>",
  "to_sha": "<40 lowercase hex characters>",
  "evidence_type": "objective-red-green",
  "finding": {
    "id": "PR-12-R123",
    "url": "https://github.com/davifernan/excalidash/pull/12#discussion_r123"
  },
  "recorded_by": {
    "role": "pr-overseer",
    "actor": "github-comment-author"
  },
  "recipe": {}
}
```

`evidence_type` is either `objective-red-green` or `finding-verification`.
`recorded_by.role` is either `pr-overseer` or `finding-verifier`. `from_sha` and `to_sha`
must differ. A record for one target SHA does not cover any later push.

### Test recipe

A test recipe binds the measurement to the test file's Git blob hash. Use the same blob on
both sides of the delta; otherwise the two observations were made with different instruments.
The failing observation must include the actual failed assertion, not only a non-zero exit
code.

```html
<!-- excalidash-fix-verification:v1
{
  "schema": 1,
  "from_sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "to_sha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "evidence_type": "objective-red-green",
  "finding": {
    "id": "PR-12-R123",
    "url": "https://github.com/davifernan/excalidash/pull/12#discussion_r123"
  },
  "recorded_by": { "role": "pr-overseer", "actor": "davi" },
  "recipe": {
    "kind": "test",
    "command": "node --test scripts/delivery-contracts.test.cjs",
    "instrument": {
      "path": "scripts/delivery-contracts.test.cjs",
      "blob_sha": "dddddddddddddddddddddddddddddddddddddddd"
    },
    "from": {
      "exit_code": 1,
      "assertion": "the exact recorded SHA delta must be covered",
      "output": "AssertionError: the exact recorded SHA delta must be covered; false !== true"
    },
    "to": { "exit_code": 0, "output": "tests 1; pass 1; fail 0" }
  }
}
-->
```

Resolve the blob identity from the tree that supplies the instrument, for example:

```text
git rev-parse <tree-ish>:scripts/delivery-contracts.test.cjs
```

### Configuration recipe

Some configuration or documentation findings do not have a meaningful failing test. Their
instrument is the exact configuration key and its old/new values. Both command outputs remain
mandatory and must differ.

```json
{
  "kind": "configuration",
  "command": "docker compose -f docker-compose.prod.yml config",
  "subject": {
    "key": "services.backend.image",
    "from_value": "zimengxiong/excalidash-backend:latest",
    "to_value": "zimengxiong/excalidash-backend:0.4.18"
  },
  "from": {
    "exit_code": 0,
    "output": "image: zimengxiong/excalidash-backend:latest"
  },
  "to": {
    "exit_code": 0,
    "output": "image: zimengxiong/excalidash-backend:0.4.18"
  }
}
```

### Equivalence recipe (NIL-492)

A behaviour-preserving refactor -- Hans found duplication or an unnecessary abstraction, the
fix changes structure without changing behaviour -- has no failing side by construction. Its
test stays green before and after; that is the entire point of the change. Neither the test
recipe (`from.exit_code !== 0`) nor the configuration recipe (`from.output !== to.output`)
can be satisfied honestly, and encoding this as either one would mean fabricating a red state
that never existed. Measured on PR #59: three inlined `[...ENTRIES].sort(byOrder).map(...)`
calls collapsed into one `renderSorted`, `chromeSlots.test.tsx` green on both `e3ce77ad` and
`72e1860c`.

A green/green pair alone proves nothing by itself, though: a test that never touches the
changed function is also green on both sides. What closes that gap is a third, separate
observation -- `coverage_probe` -- where `subject` (the exact code the finding touched) was
deliberately broken by file copy, per this document's red-proof convention (**never** by
reverting the actual fix commit -- that would test the wrong tree), and the *same*,
unmodified instrument went red on it, naming the assertion that actually failed. That is the
proof the instrument would have caught a real regression at this exact spot, not just that it
ran and passed.

```html
<!-- excalidash-fix-verification:v1
{
  "schema": 1,
  "from_sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "to_sha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "evidence_type": "objective-red-green",
  "finding": {
    "id": "PR-59-R42",
    "url": "https://github.com/davifernan/excalidash/pull/59#discussion_r42"
  },
  "recorded_by": { "role": "pr-overseer", "actor": "davi" },
  "recipe": {
    "kind": "equivalence",
    "command": "npx vitest run frontend/src/pages/editor/chromeSlots.test.tsx",
    "instrument": {
      "path": "frontend/src/pages/editor/chromeSlots.test.tsx",
      "blob_sha": "dddddddddddddddddddddddddddddddddddddddd"
    },
    "subject": {
      "path": "frontend/src/pages/editor/chromeSlots.tsx",
      "description": "the three inlined [...ENTRIES].sort(byOrder).map(...) calls collapsed into renderSorted"
    },
    "from": { "exit_code": 0, "output": "tests 6; pass 6; fail 0" },
    "to": { "exit_code": 0, "output": "tests 6; pass 6; fail 0" },
    "coverage_probe": {
      "exit_code": 1,
      "assertion": "expected slot order [main-menu, comments] to equal [comments, main-menu]",
      "output": "AssertionError: expected slot order [main-menu, comments] to equal [comments, main-menu]"
    }
  }
}
-->
```

`instrument.blob_sha` is a single value, same as the test recipe: `from`, `to` and
`coverage_probe` all run the identical, unmodified instrument -- only the source tree under
test changes between the three runs. `coverage_probe.output` must literally contain
`coverage_probe.assertion`, the same non-paraphrased rule the test recipe's `from` observation
uses and for the same reason: a hand-typed summary of what failed is not evidence that
anything actually failed there.

### Instrument-repair recipe (NIL-522)

Some fixes have no production-code lever at all: the finding and its repair live entirely in
the test's own measurement methodology, and the production code the finding is *about* is
provably unaffected. Measured on PR #78 (NIL-506): `audit.test.ts`'s `logAuditEvent` tests
wrote zero rows because the test toggled `ENABLE_AUDIT_LOGGING` via `process.env` in
`beforeAll`, racing `config.ts`'s one-time env snapshot. The accompanying change to
`audit.ts` (dropping a dead `await import("../config")` workaround) looked like the fix, but
holding it fixed and swapping only the test file's blob proved otherwise: the new test passed
10/10 against *both* the old and the new `audit.ts`, and the old test failed against *both* --
no production-code delta exists that flips the outcome. Neither the `test` recipe (needs a
from/to production-code delta under one fixed instrument) nor the `equivalence` recipe (needs
the *same* instrument on both sides, and this repair changes the instrument by definition)
can represent this honestly.

This recipe is `test` mirrored: production code (`subject`) is the constant, deliberately
broken by file copy and identical on both runs -- never by reverting the actual fix commit,
the same red-proof convention every other recipe in this document uses. The instrument is the
only variable, and the two instrument blobs must **differ** -- the literal inversion of the
`test` recipe's same-blob-both-sides rule, and a reader must see that immediately. It proves
not just "the new test passes" but "the old test was blind to a real bug the new one catches",
which is the property that actually made the repair necessary.

```html
<!-- excalidash-fix-verification:v1
{
  "schema": 1,
  "from_sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "to_sha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "evidence_type": "objective-red-green",
  "finding": {
    "id": "PR-78-C5398252784",
    "url": "https://github.com/davifernan/excalidash/pull/78#issuecomment-5398252784"
  },
  "recorded_by": { "role": "pr-overseer", "actor": "davifernan" },
  "recipe": {
    "kind": "instrument-repair",
    "command": "cd backend && npx vitest run src/utils/__tests__/audit.test.ts",
    "subject": {
      "path": "backend/src/utils/audit.ts",
      "description": "config.enableAuditLogging check replaced with a direct process.env.ENABLE_AUDIT_LOGGING read, bypassing config.ts -- held identical for both instrument runs, never committed"
    },
    "old_instrument": {
      "path": "backend/src/utils/__tests__/audit.test.ts",
      "blob_sha": "0aef1bf4d73d1963d57a25e97eb5fccf7003523c"
    },
    "new_instrument": {
      "path": "backend/src/utils/__tests__/audit.test.ts",
      "blob_sha": "b1d467a667ed03a4f871d0731e6cfcf8896acd8e"
    },
    "from": { "exit_code": 0, "output": "Test Files  1 passed (1)\n     Tests  10 passed (10)" },
    "to": {
      "exit_code": 1,
      "assertion": "AssertionError: expected +0 to be 1",
      "output": "AssertionError: expected +0 to be 1 // Object.is equality\n\n Test Files  1 failed (1)\n      Tests  9 failed | 1 passed (10)"
    }
  }
}
-->
```

`subject` has no `blob_sha`, the same as `equivalence`'s subject: the broken state is
deliberately never committed, so there is no stable git blob to pin -- `description` is the
record of what was changed and why, read by a human replaying the two runs. `old_instrument`
and `new_instrument` each pin their own blob, and `checkFixVerificationCoverage` rejects a
record where they match: same blob on both sides is not an instrument repair, it is nothing.
`from` (old instrument) must stay green (`exit_code === 0`) despite the broken subject; `to`
(new instrument) must go red, with its own `assertion` appearing verbatim in its `output` --
the identical non-paraphrased rule the `test` recipe's `from` and the `equivalence` recipe's
`coverage_probe` both already enforce.

Do not encode an otherwise unsupported measurement as an unstructured prose recipe. Add a
new schema version through a reviewed contract change instead.

## Reader contract

Pass the exact delta and GitHub issue-comment objects on standard input:

```text
node scripts/delivery-contracts.cjs fix-verification
```

Input shape:

```json
{
  "fromSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "toSha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "comments": []
}
```

The result has `covered: true` only for a valid record whose two SHAs exactly match the query.
No record, a malformed record, an author mismatch, or a later target SHA returns
`{"covered":false,"code":"uncovered",...}`. An uncovered result is data, not a process exit
failure: this command is the reader consumed by NIL-391, not the enforcement gate itself.

The reader never executes the recorded command. Automatic replay must use a separately
reviewed, isolated execution path; PR comments are untrusted command input.

## Checking a PR after a finding fix (NIL-595)

The `fix-verification` reader above needs the exact `fromSha`/`toSha`/`comments` already worked
out by hand. `checkFixVerificationStatus` (same file) does that lookup for you: given a PR, its
reviews, its review comments, and its conversation comments, it finds Hans's latest valid
review, compares it to the current head, and -- only if the head has actually moved since that
review -- runs the coverage check above against the delta. It never throws on a stale head (that
is `checkReviewedHead`'s job, a hard admission check); its whole purpose is to describe the
situation, including the uncovered one.

Run it as a GitHub Action: **Actions -> Fix-Verification Status -> Run workflow**, pull request
number as the only input. It posts one comment naming the code
(`draft` / `no-review` / `current` / `verified` / `unverified`) and, for `unverified`, the exact
`fix-verification` command and JSON to record one. This is a tool the Overseer reaches for by
hand after observing a finding-fix push -- not a required check, and not triggered
automatically on every push (see that workflow file's own header for why: this reader stays "the
reader consumed by NIL-391, not the enforcement gate itself", per this document's own line
above, and a gate nobody can satisfy yet trains people to ignore red).
