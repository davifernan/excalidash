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

Release tags follow `vX.Y.Z-nilo.N` -- see
[docs/architecture/UPSTREAM_MAINTENANCE.md](docs/architecture/UPSTREAM_MAINTENANCE.md)
("Tag-Namensraum") for why the suffix is permanent rather than cosmetic.

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
