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
