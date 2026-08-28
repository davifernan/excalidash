# NIL-646 / NIL-647 evidence

Recorded with Playwright `video: "on"` against the fixed code
(`fix/nil-646-sticky-caret`), chromium project, 1280x720 viewport.

- `nil-646-caret-space-backspace.webm` -- place a note, press Space, press
  Backspace. Font size and caret stay stable across the round trip instead of
  jumping on the first keystroke and leaving an unremovable character.
- `nil-647-connect-child-speed.webm` -- click a note's connection handle. The
  child note now lands well under 500ms (measured ~1092ms before the
  `StickyHandles.tsx` ActiveTool-shape fix), at the wider `CHILD_GAP` (96,
  was 48).
- `nil-647-rejected-save-rollback.webm` -- a brand-new note whose first save
  the server rejects (mocked 500) stays on the board with its typed text
  intact and shows a toast, instead of silently disappearing (the NIL-615
  failure mode).
