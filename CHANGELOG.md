# Changelog

All notable ExcaliDash-fork releases are recorded here, newest first. This file replaces
the old `RELEASE.md`, which only ever held the *current* release and was overwritten on the
next one -- every earlier release's notes were gone the moment a new one was written. That is
the gap this file exists to close: a place a user can actually see everything that changed,
not just the latest slice of it.

Entries are grouped **Added** / **Fixed** / **Changed**, and only describe what a person using
ExcaliDash notices -- no ticket numbers, no PR numbers, no internal component names. See
[docs/architecture/RELEASE_PROCESS.md](docs/architecture/RELEASE_PROCESS.md) for how an entry
gets here: going forward, each pull request's mandatory `User-Facing:` line is the raw
material, collected and grouped automatically at tag time and polished by a human before the
release is published. Nothing here is invented from commit history after the fact.

Release tags follow `vX.Y.Z` -- see
[docs/architecture/UPSTREAM_MAINTENANCE.md](docs/architecture/UPSTREAM_MAINTENANCE.md)
("Tag-Namensraum") for the collision check that makes a suffix unnecessary.

## v0.15.0 -- 2026-08-30

This release lays the groundwork for agents on the board: an agent can now read a bounded
slice of a board, the board itself shows what it is currently reading, the connection runs
through an authenticated adapter instead of open access, an instruction to an agent needs
explicit human approval before it takes effect, and board owners decide whether guest
contributions flow into what an agent gets to see at all. These belong together because
together they answer one question: what may an agent see, and who decides that.

### Added

- **Agents on the board.** A board can now mark a bounded area as an agent workspace. A
  connected agent explores an immutable snapshot of the board there instead of the full,
  constantly changing scene -- what it reads stays stable for the duration of its run, even
  while people keep working on the board.
- Boards now have an optional agent panel to start and query a connected, authenticated agent
  instance while the canvas stays fully usable.
- Agents show directly on the board frame which note or frame they are currently reading, not
  only in a separate side panel.
- An instruction to an agent -- a sticky note carrying a task, say -- must now be explicitly
  approved before it is even offered in the agent panel. Approving and actually running it are
  two separate actions. If the instruction's text changes afterwards, the approval lapses and
  has to be confirmed again.
- Board owners can now separately allow or block a guest's own content from being read by an
  agent inside the agent workspace -- independent of the guest's edit or upload rights, and
  enforced in two places rather than one. If that rule excludes elements of unknown origin,
  the owner is told how many and why.

### Fixed

- During collaborative editing, board content no longer occasionally flickers or disagrees on
  font size and geometry while someone else is typing.
- A sticky note a collaborator receives only through a live update now fits its font to the
  note correctly -- even when the label was bound during another person's edit.
- An edit that only changed a property such as an element's opacity could be silently
  discarded when an update from someone else arrived; such edits are now preserved.

### Known issues

- In Firefox and Safari, undo may not remove a sticky note created through a binding point.
  It may undo the action before it instead. Select and delete that sticky note manually before
  undoing earlier work. -- unchanged from v0.14.0; none of the commits since the last tag
  touch the cause.

### Not in this round

- **Terminal tab.** Deliberately not built. The existing rights and lease mechanism assumes
  every shared effect is a single, server-checked call -- a running process is not, and a
  terminal would need a second, sandbox-based enforcement layer that does not exist anywhere
  in the repository. On top of that it is a lasting product-class change, from drawing tool to
  compute provider.
- **Switch to AGPL.** Open decision, not yet taken. Concerns adopting AI functionality from
  the AGPL-licensed `origin/alpha`; no effect on this release while undecided.
- **Shared workspace pagination.** Still held back. A controlled measurement under Node 24
  shows a real, statistically clear slowdown against `main` in both Chromium and WebKit.

## v0.14.0 -- 2026-08-29

Most of this release is repair: what turned up while testing 0.13 has been fixed. Alongside
that, a round on the checking itself -- several tests could not have failed even if the code
was broken, and what actually ships was never being tested.

### Added

- The Timer corner is now a small, configurable toolbar. "Start a vote" and "Comments" sit next
  to the timer, and a settings button lets you choose which of your team's features stay there.
- Board owners can let guests upload files and see comments -- per board and instance-wide, from
  Admin > Guest Access and each board's Share dialog.

### Fixed

- Comments can be written again. Enter sends, Shift+Enter inserts a new line.
- Placing a sticky note, or connecting one to a new note, feels instant. The note's text no
  longer keeps a stray character from the first keystroke.
- Connected sticky-note arrows use your current arrow style instead of a fixed colour.
- The grid choice follows you across boards instead of being forgotten on reload.
- Pages send their intended security headers on every load -- Content-Security-Policy,
  clickjacking and MIME-sniffing protection -- not only on some.

### Changed

- Nothing in how the app is used. The rest of this release is beneath the surface: the browser
  tests now also run against the image that actually ships, not only against the development
  server; the cross-engine suite runs one job per browser instead of racing a shared
  twelve-minute limit; database transactions have room before they time out; and several tests
  that could never have failed now can.

### Known issues

- In Firefox and Safari, Undo may not remove a Sticky Note that you created by clicking a
  connection point. It can undo the action before it instead. Select that Sticky Note and delete
  it manually before using Undo for earlier work.

## v0.13.0 -- 2026-08-27

Added on 2026-08-29: this entry was missing when v0.13.0 was published -- exactly the gap this
file exists to close.

### Added

- Guest permissions, per board and per capability. Board owners decide whether link guests may
  upload files and whether they see comments.
- Markdown edits appear live. Everyone on the board sees changes as they are typed, not only
  after saving.
- Sticky Note connection points. Hover a note, click a dot on its edge, and a connected child
  note appears with the cursor already in it.

### Fixed

- Markdown work is no longer lost. Saving could silently fail after a document was replaced;
  it now recovers, and says so when it genuinely cannot save.
- Accepting a "follow me" invitation now keeps following instead of moving the view once.
- The collaborator bar stays compact -- avatars stack with a +N count.
- Restarting the timer leaves it where you put it.
- A Sticky Note stays stable while someone else types in it.
- Connection trouble is visible without being loud, and silent while the connection is healthy.
- Overlays keep a predictable order -- comments, widgets, menus, notifications, dialogs.
- Excalidraw's command palette and canvas search are reachable from the hamburger menu.

### Changed

- Sticky Note text starts large and shrinks smoothly instead of jumping between fixed sizes.
- Pin and Collapse are gone from the element menu.
- Away collaborators are easier to read, with an "away" label and a muted cursor.
- Every floating toolbar looks and behaves the same.
- Notifications appear in one consistent stack.
- Self-hosted error tracking uses GlitchTip with Postgres and without Redis.

### Known issues

- In Firefox and Safari, Undo may not remove a Sticky Note that you created by clicking a
  connection point. It can undo the action before it instead. Select that Sticky Note and delete
  it manually before using Undo for earlier work.

## v0.12.0 -- 2026-08-26

### Added
- Dragging a box now takes along whatever it points to via a connecting arrow, on any board -- no tool needed.
- Pin (P) and collapse (the floating "Collapse" toolbar) work on any node with children now, not just an imported mind-map tree -- no tool, no mode to switch into first. A pinned node's position survives the next "Arrange" run; a collapsed node's descendants hide behind a badge that expands them again.

### Fixed
- Fixes an intermittent bug where a collapsed subtree's count badge sometimes never appeared for a collaborator who only received the collapse over the socket, even though the collapse itself synced correctly.

### Changed

- The mind-map tool's own mode is gone. "Import mind map..." now creates an ordinary tree of boxes and arrows that behaves exactly like a hand-drawn one -- ambient drag, native undo, no separate mode to opt into. "Arrange mind map" is renamed to "Arrange" and now works on any ambient tree, not just an imported one.

## v0.11.0 -- 2026-08-25

### Added

- Dragging a mind-map node onto another one now moves it there in the tree, with a live preview of the drop target before you let go.
- Mind-map nodes can now be pinned in place, so their position survives the next "Arrange mind map".
- A mind-map branch can now be collapsed to a count badge and expanded again with one click.
- A small colored dot next to the menu now shows live connection state (green connected, amber reconnecting, red offline) instead of nothing.
- When a collaborator's cursor is outside the part of the board you're currently viewing, a small arrow at the edge of your screen points toward them.

### Changed

- Sticky notes now show the colour picker while you're still typing, so you can change the colour without losing your place.

## v0.10.0 -- 2026-08-25

### Added

- You can now build mind maps directly on the canvas -- pick the Mind Map tool, click to start a root idea, press Tab for a child or Enter for a sibling, and drag any node to take its whole branch with it. "Arrange mind map" tidies the layout on demand.
- Editing a Markdown document now shows a live preview next to the source, so bold, italic, and other formatting appear as you type instead of only after switching to view mode.

### Fixed

- The workshop timer's settings menu now closes itself the moment you press Start, the timer looks like the rest of the canvas chrome until it's actually running (then it turns white, like the main toolbar), and a short chime plays for anyone who's touched the timer when it runs out.

### Changed

- The floating toolbar on a document or PDF now shows a clear divider between the filename and its action buttons, so the rename pencil no longer reads as acting on the whole toolbar.
- Mind map edges now render as fully connected, native arrows that stay attached the way any other Excalidraw connector does.
- The top-right control bar (avatars, invite, share, Library) is now visually recessed grey behind the main toolbar, matches the toolbar's height, and separates into a presence group and an actions group with a hairline divider that only appears when someone else is on the board.

## v0.9.0 -- 2026-08-25

### Fixed

- Floating document controls now move clear of editor tools and long filenames stay compact.
- Markdown files on a board can now be edited, saved across reloads, and clearly locked while another person is editing.

### Changed

- Administrators can opt into self-hosted error tracking while board content and user identities stay out of reports.

## v0.8.0 -- 2026-08-25

### Fixed

- Collaborator names no longer keep the large-selection label after that selection has been cleared.
- Cursor traffic protection no longer interrupts image uploads with internal rate-limit notices.
- Canvas controls are now compact, aligned, and grouped into consistent toolbars.

### Changed

- Native drawing export coverage now prepares stored board images through the durable server boundary instead of racing editor autosave.
- Release-Versionen heissen jetzt schlicht vX.Y.Z.
- Die naechste Version heisst 0.8.0.
- PDF, Markdown/text and sticky-note controls now appear in a viewport-sized toolbar beside the single selected element.

## v0.7.0-nilo.1 -- 2026-08-24

### Added

- Boards can now be starred from the dashboard and pinned to the top of your board list.
- Board cards show where a board came from -- created here, shared with you, or imported --
  instead of leaving that unstated.
- The dashboard has new "Open now" and "Favorites" filters, with clearer empty-state messaging
  when a filter has no matches instead of a blank-looking screen.
- The dashboard's presence indicators (who's currently viewing or editing a board, and how
  many guests are on it) now come from one consistent source across every card and view, so
  two different counts can no longer disagree with each other.

### Fixed

- The shared-boards view no longer silently drops boards that were shared directly with you
  but never organized into a collection.
- A departing teammate's trashed boards can no longer resurface as active, organized boards
  for whoever inherits their content.
- A board's guest count now shows as genuinely unknown, instead of a misleading "0", once the
  board has more concurrent viewers than the dashboard can individually track.
- Fixed a real-time collaboration bug where a sticky note being actively edited by one person
  could occasionally be overwritten by another editor's change arriving in a different order.
- Fixed a bug in collection sharing where a permission level outside the two documented
  options (view, edit) could be silently accepted instead of rejected.

### Changed

- Documents with certain long stretches of blank content now render dramatically faster in
  Safari/WebKit -- a case that used to take over a second now takes on the order of ten
  milliseconds.

<details>
<summary>Show upgrade steps</summary>

### Data safety checklist

- Back up the backend volume (`dev.db`, secrets, uploads, and S3 bucket data) before upgrading.
- Let migrations run on startup (`RUN_MIGRATIONS=true`) for normal deploys.
- Run `docker compose -f docker-compose.prod.yml logs backend --tail=200` after rollout and
  verify startup/migration status.

### Recommended upgrade (GHCR compose)

### Pin this release (required)

Both services read the same `EXCALIDASH_IMAGE_TAG` from `.env`. There is no
per-service `image:` tag to edit in `docker-compose.prod.yml` — and no `:latest`
fallback if the variable is unset, so compose refuses to start without it.

```bash
# .env
EXCALIDASH_IMAGE_TAG=0.7.0
```

```bash
docker compose --env-file .env -f docker-compose.prod.yml pull
docker compose --env-file .env -f docker-compose.prod.yml up -d
```

To roll back, put the previous value back into `.env` and repeat the two commands.
No compose-file edit is involved in either direction.

</details>

## v0.6.0-nilo.1 -- 2026-08-24

Retroactive entry. This tag marks the point where this fork's own roadmap (31 merges,
covering everything from the Excalidraw adapter and board-ownership boundaries through team
areas, comments and notifications, workshop presentation mode, and team library/discovery)
first reached version 0.6.0 in `VERSION` -- but nobody tagged it or wrote it down at the time,
which is the exact gap this changelog exists to close. Detailed, user-facing notes for that
range were not tracked as they shipped, and reconstructing them now from commit archaeology
would risk describing something other than what was actually delivered, which is precisely
the failure mode this file's sourcing rule (above) refuses to allow. The commit and pull
request history on `main` up to this point remains the authoritative record for anyone who
needs it in more detail than a summary line can honestly give.
