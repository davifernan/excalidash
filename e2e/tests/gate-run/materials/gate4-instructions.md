# Gate 4 — what Davi actually does

There is no setup script for this gate: its fixture is a written decision, not board
state. Nothing here can be automated without pretending to make the decision itself.

1. **Confirm Gates 1–3 each have a `passed` `GATE RUN` comment on NIL-701** and paste
   their links into `gate4-checklist.md`. If any is missing or `failed`, stop — Gate 4
   is not runnable yet, and that is the correct outcome, not a blocker to work around.
2. **Run the representative scenario** (inspect a board-threaded agent result via the
   board thread and the external runtime adapter, terminal tab disabled) and note
   whether it was completable, and if not, exactly what concretely couldn't be done
   without a terminal.
3. **Fill every row of the checklist** in `gate4-checklist.md` with a real number, a
   real limit, or a named owner — not a description of the concern.
4. **Write `go` or `no-go` and sign it.** `docs/architecture/TERMINAL_TAB_PRECONDITIONS.md`
   (NIL-681) has the full precondition list and open questions this decision should be
   checked against.
5. **Copy the completed checklist and decision into the `GATE RUN` comment.**
