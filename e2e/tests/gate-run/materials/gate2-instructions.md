# Gate 2 — what Davi actually does

Everything else is already handled by the setup/recording scripts. This is only the
handful of steps that must come from a human.

## Before you start: one unresolved finding

The board's real status vocabulary is `working | idle | blocked | done | unknown`
(`backend/src/agent/presence.ts`), and the on-canvas label only ever renders
`reading`, `blocked`, `done`, or `reading` as the default
(`frontend/src/pages/editor/useAgentPresenceOverlay.tsx`'s `statusLabel`). The board
will **never literally show "working" or "waiting"** — "waiting" is not a valid status
at all today. `gate2PresenceFixture`'s expected answers use exactly those two words.

This means Gate 2 cannot be run, as literally specified, against the real product
today without one of:

- rewording the fixture's expected answers to the product's real vocabulary
  (`reading`/`blocked`/`done`), or
- extending the status vocabulary first (a product change, out of scope for this
  preparation).

That decision is not for this package to make. Everything below still stands up the
rest of Gate 2 correctly; only the exact wording of the six expected answers needs a
call before you run it for real.

## The handful of steps

1. **Run the setup script once**, from `backend/`:
   `GATE_OWNER_EMAIL=<your account> API_URL=<your running backend> npx ts-node scripts/gate-run/setup-gate2.ts`
   It prints a board URL. Open it in your own browser, logged in as the owner account
   you gave it.
2. **Run the recording spec once**, from `e2e/`, before you start asking yourself
   the question:
   `GATE_OWNER_EMAIL=... GATE_OWNER_PASSWORD=... GATE_OBSERVER_EMAIL=... GATE_OBSERVER_PASSWORD=... npx playwright test gate-run/gate2-record.spec.ts --project=chromium`
   The observer account must be a real second account with no other relationship to
   this drawing — the script grants it plain view access itself. This single command
   captures the privacy signal and takes the six screenshots; you do not start or stop
   anything else.
3. **Answer the fixed question** ("Which agent is working in which Context, and what
   is its status?") at the six pre-registered seconds, from your own board view —
   using the vocabulary you decided on in the step above, not from memory of the
   fixture text. Say the answer out loud or type it; whichever you do, write down the
   literal words and the time, unedited, before looking at anything else.
4. **Repeat against the Markdown file** (`gate2-markdown-status.md`), in the fixture's
   crossed order (session 1: board then Markdown; session 2: Markdown then board).
5. **Copy your raw answers, times, and the recording script's output paths** into the
   `GATE RUN` comment format from the runbook. The observer capture and screenshots
   are already on disk; you only transcribe your own answers.
