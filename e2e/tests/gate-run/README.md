# NIL-701 gate-run: stage setup for Gates 2, 3, 4

This directory builds the stage, not the play: it stands up fixture state and
recording, never a gate's judgment, an answer, or a passed/failed result. Read
[`docs/architecture/AGENT_CONTEXT_GATE_RUNBOOK.md`](../../../docs/architecture/AGENT_CONTEXT_GATE_RUNBOOK.md)
first — it is the authority on fixture, procedure, and pre-registered pass rule for
every gate; this directory only makes those runnable.

Gate 1 already has its own executable fixture
(`backend/src/__tests__/agentBoardMount.integration.ts`) and was run for real on
2026-08-30; nothing here touches it.

| Gate | Setup                                      | Materials                                                                                                             | Recording                                 |
| ---- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 2    | `backend/scripts/gate-run/setup-gate2.ts`  | `materials/gate2-markdown-status.md`, `materials/gate2-instructions.md`                                               | `gate2-record.spec.ts` (automated)        |
| 3    | `backend/scripts/gate-run/setup-gate3.ts`  | `materials/gate3-terminal-transcript.txt`, `materials/gate3-timer-log-template.md`, `materials/gate3-instructions.md` | none needed — persisted content, not live |
| 4    | none — a written decision, not board state | `materials/gate4-checklist.md`, `materials/gate4-instructions.md`                                                     | none                                      |

## One unresolved finding, flagged rather than worked around

Gate 2's fixture expects the board to literally show the words "working" and
"waiting". The product's real status vocabulary (`backend/src/agent/presence.ts`) is
`working | idle | blocked | done | unknown`, and the on-canvas label
(`useAgentPresenceOverlay.tsx`) only ever renders `reading`, `blocked`, `done`, or
`reading` as its default — "waiting" is not representable at all today. Confirmed by
reading both files directly, not assumed. This is a genuine fixture/product
vocabulary mismatch, not something this package can resolve by editing the fixture
or the product — see `materials/gate2-instructions.md`'s opening section for what it
means for actually running Gate 2.

## Why setup is split between `backend/scripts/` and `e2e/tests/`

Registering an Agent Context (the frame → context binding every gate depends on) has
no HTTP route today — it is only ever called from backend code, the same way Gate 1's
own executable fixture calls it. Gate 2's setup additionally needs one thing that
genuinely lives only in the running server process's memory: the live focus/presence
broadcast a real agent tool call produces. That is reachable over HTTP (the same route
a real runtime would call), so the setup scripts live in `backend/scripts/` (direct
module calls for state) and make one real HTTP call each for that one broadcast.
Everything that needs a real second browser and a real socket connection — Gate 2's
observer capture and screenshots — lives in `e2e/tests/gate-run/` instead, using the
existing Playwright/auth helpers rather than a new toolchain.

Both `setup-gate2.ts` and `setup-gate3.ts` were run end-to-end against a throwaway
local instance while preparing this package (real drawing, real Agent Contexts, real
mounts, and — for Gate 2 — a real focus broadcast confirmed via `AgentToolAudit` rows
and a real persisted orchestrator thread for Gate 3, confirmed by reading the rows
back). That throwaway instance and its data were discarded afterward; nothing from it
is part of this package.
