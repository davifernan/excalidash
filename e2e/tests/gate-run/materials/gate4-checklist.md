# Gate 4 — cost/risk checklist (fill after the terminal-disabled scenario)

Prerequisite: Gates 1, 2, and 3 each have a recorded `GATE RUN` comment on NIL-701
with `Result: passed`. Link all three here before filling anything below. A missing
or `failed` prerequisite fails Gate 4 regardless of what follows.

- Gate 1 run: <link>
- Gate 2 run: <link>
- Gate 3 run: <link>

Representative scenario (`gate4TerminalDecisionFixture.representativeScenario`):
inspect a board-threaded agent result using only the board thread and the external
runtime adapter, terminal tab disabled. Record whether this scenario was completable
without it, and if not, exactly what was missing.

Every field below needs either a measured cost, an explicit limit, or an explicit
risk owner — not a description. "TBD" or "later" is a fail, not a placeholder.

| #   | Field             | Measured cost / explicit limit / risk owner |
| --- | ----------------- | ------------------------------------------- |
| 1   | sandbox-isolation |                                             |
| 2   | cpu-limit         |                                             |
| 3   | ram-limit         |                                             |
| 4   | time-limit        |                                             |
| 5   | storage-limit     |                                             |
| 6   | network-access    |                                             |
| 7   | secret-access     |                                             |
| 8   | session-lifecycle |                                             |
| 9   | output-volume     |                                             |
| 10  | operational-owner |                                             |

## Decision

`go` or `no-go`, signed and dated:
