# Gate 3 — what Davi actually does

1. **Run the setup script once**, from `backend/`:
   `GATE_OWNER_EMAIL=<your account> npx ts-node scripts/gate-run/setup-gate3.ts`
   It prints a board URL with a shared orchestrator thread already carrying all four
   tasks' context/status/result, in fixture order. No live recording is needed here —
   unlike Gate 2, this is persisted content you read by opening the page, not
   something that has to stay broadcasting.
2. **Open `gate3-terminal-transcript.txt`** in a plain text view — that is the
   terminal-transcript surface, fixed and already written; nothing to set up.
3. **Run the two sessions in the fixture's crossed order**
   (`gate3BoardThreadFixture.balancedOrder`, copied into `gate3-timer-log-template.md`'s
   rows): session 1 does `task-atlas`/`task-beacon` on the board thread and
   `task-cobalt`/`task-delta` on the terminal transcript; session 2 mirrors it.
4. **Time each task with a real stopwatch**, starting the instant the task prompt is
   shown to you and stopping only once you've given the complete answer. Write the
   elapsed milliseconds, the answer, and whether you asked a clarifying question
   directly into `gate3-timer-log-template.md` — do not go back and correct a row
   after moving to the next task.
5. **Copy the filled table and your median-time calculation into the `GATE RUN`
   comment.** The pass rule (board median strictly below terminal median, no more
   misassignments, no more clarifying questions, equality fails) is pre-registered in
   the runbook — this script does not compute or judge it.
