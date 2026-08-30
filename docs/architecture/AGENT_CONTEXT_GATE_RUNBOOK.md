# Agent Context Gate Runbook

Status: execution preparation for NIL-701. This document makes the four gates in
[`AGENT_CONTEXT.md`](AGENT_CONTEXT.md) executable. It does **not** execute a gate,
does not assert that any gate passed, and does not authorize further Agent Context
delivery. Fixture values live in
[`e2e/tests/fixtures/agentContextGateFixtures.ts`](../../e2e/tests/fixtures/agentContextGateFixtures.ts)
at version `nil-701-gate-fixtures-v1`.

## Non-negotiable run discipline

Before the first observation, the operator copies the relevant fixture version, task
texts, answer key, sample timestamps, surface order, and pass/fail rule into the
NIL-701 run comment. These values are then immutable for that run. The operator
records raw answers, elapsed time, questions, socket capture, screenshots, and the
fixture revision; a later interpretation may not change a threshold or discard an
unfavourable observation.

Every completed run records this exact shape in a NIL-701 comment:

```text
GATE RUN
Gate: gate-N
Fixture version/SHA: <fixture version and git SHA>
Operator: <name>
Participants/sockets: <identities and roles>
Surface/order: <pre-registered order>
Raw observations: <answers, timestamps, times, event capture>
Pass rule fixed before run: <copied rule>
Result: passed | failed
Reason: <comparison to the fixed rule, not a reinterpretation>
Artifacts: <trace/log/screenshot URLs>
```

`e2e/tests/agent-context-gate-fixtures.spec.ts` checks that the fixture itself has
not silently changed. It is not gate evidence.

## Gate 1 — Board-Mount

### Fixture and setup

Use `gate1BoardMountFixture`. Seed its two frames and explicit cross-context edge
using the existing executable mount fixture in
`backend/src/__tests__/agentBoardMount.integration.ts`; it already creates the
fixed `ORANGE` answer in the mounted Context and `PURPLE`/secret/asset in the
forbidden Context. Create a mount for only `context-launch` at
`gate-1-revision-orange`; give the real agent only its returned mount token and
the public exploration API. The operator, not the agent, retains board edit access.

### Fixed procedure

1. Show the agent only the fixed question from the fixture.
2. Record its answer and every mount-tool envelope.
3. Call `readFrame` for the mounted launch frame.
4. Mutate the current board's launch text to `BLUE`.
5. Call the identical `readFrame` again, then `revisionStatus`.
6. Attempt the fixture's five forbidden-context accesses in listed order.
7. Export the `AgentToolAudit` rows for this `runId` and the API envelopes.
8. Run the unmounted counter-attempt separately: it may not obtain `ORANGE`.

### Pre-registered decision

Pass only if the answer is exactly `ORANGE`; both identical reads are byte-equal
and have identical result hashes and revision IDs; every successful tool response
has that same revision ID; audit contains no dump/snapshot fallback; and no
forbidden attempt discloses B's text, asset metadata, or bytes. Any other answer,
drift, fallback, or disclosure is fail. The operator measures API envelopes and
`AgentToolAudit`; the artifact is the exported audit plus the transcript.

## Gate 2 — Visible Agent Presence

### Fixture and setup

Use `gate2PresenceFixture`. Seed four distant frames with the exact fixture labels.
Start the three public runs on Atlas/Beacon/Cobalt with their fixed status and
focus target. Start `run-private-finance` on Private finance with private audience.
Open one board view for Davi and one authenticated foreign-observer socket. Capture
only the four `privateEventNames` from that socket. Prepare a Markdown file that
contains the same three public mappings and no extra information.

`backend/scripts/gate-run/setup-gate2.ts` builds exactly this state against a real
running instance in one command; `e2e/tests/gate-run/gate2-record.spec.ts` opens the
foreign-observer socket and takes the six screenshots automatically. See
`e2e/tests/gate-run/README.md` for both, and its flagged finding first: the board's
real status vocabulary cannot render the fixture's "working"/"waiting" words as
written (`working | idle | blocked | done | unknown` on the wire, and the on-canvas
label only ever shows `reading`/`blocked`/`done`) -- resolve that wording question
before running this gate for real.

### Fixed procedure

1. Start the 30-second clock when all four runs are visible to their authorized
   audience.
2. At seconds 0, 5, 10, 15, 20, and 25 ask Davi: “Which agent is working in
   which Context, and what is its status?” Record the literal answer, latency,
   and every clarification request before revealing the key.
3. Simultaneously retain the observer socket capture for Focus, Runtime, and
   Presence events from the private run.
4. Repeat the identical task set against the Markdown status file, using the
   fixture's crossed `comparisonOrder`: session 1 Board then Markdown; session 2
   Markdown then Board. Do not reuse answers between sessions.

### Pre-registered decision

The hard Gate-2 pass rule is all six Board answers exactly matching all three
fixture mappings, zero clarification requests, and exactly zero private Focus,
Runtime, or Presence events at the foreign observer. One wrong mapping, one
question, or one private event fails Gate 2. Board-versus-Markdown is a recorded
counter-attempt (correct mappings, latency, questions), not a way to relax this
hard rule. Davi measures answers and time; the observer capture is the privacy
signal; screenshots of the Board mapping and the socket log are retained.

## Gate 3 — Board-Faden versus Terminal

### Fixture and setup

Use `gate3BoardThreadFixture`. Place each task's identical context, status, and
result once in the Board thread and once in a linear terminal transcript. The
operator checks each surface against the fixed answer key before Davi sees either.

`backend/scripts/gate-run/setup-gate3.ts` seeds the real shared orchestrator thread
with all four tasks in one command; `e2e/tests/gate-run/materials/gate3-terminal-transcript.txt`
is the fixed terminal-transcript side. See `e2e/tests/gate-run/README.md`.

### Fixed procedure

1. Run the two fixture sessions in their exact crossed order.
2. For each prompt, start a monotonic timer when the prompt appears and stop it
   only after Davi gives the complete fixed answer.
3. Record elapsed milliseconds, answer, any wrong assignment, and every
   clarification request. Do not correct an answer before recording it.
4. Preserve both raw transcripts and timer rows.

### Pre-registered decision

Pass only if the Board median elapsed time is strictly lower than Terminal's,
and Board has no more misassignments and no more clarification requests. Equality
fails. The terminal run is the counter-attempt; it must differ only in surface,
never in target information, prompt, answer key, or participant. Davi measures
time/answers; the raw timer table and both surface captures are the evidence.

## Gate 4 — Terminal-Reiter

### Fixture and setup

Use `gate4TerminalDecisionFixture` only after recorded Gate 1–3 passes. Prepare
the representative Board-thread/external-adapter case with the terminal tab
disabled, plus the ten-item cost/risk checklist. This gate is not observable in
the current state until the three prerequisite results exist; it must not be
declared passed from preparation alone.

`e2e/tests/gate-run/materials/gate4-checklist.md` is the ten-item template; there is
no setup script, since this gate's fixture is a written decision, not board state.

### Fixed procedure

1. Verify and link the three prior `passed` run records.
2. Execute the representative scenario with the terminal tab disabled.
3. Davi completes every checklist field with a measured cost, an explicit limit,
   or an explicit risk owner.
4. Davi writes `go` or `no-go` and signs the decision record. A terminal-free
   failure is recorded as evidence against the present design only when it is
   concretely unresolvable by the Board and adapter surfaces.

### Pre-registered decision

Pass only with recorded Gate 1–3 passes **and** a written `go` that addresses all
ten checklist fields. Missing evidence, an unbounded field, no decision, or
`no-go` fails. The terminal-disabled scenario is the counter-attempt. Davi
measures the scenario and decision; the signed decision record plus cost/risk
table are the artifacts. Until then NIL-681 remains non-dispatchable.
