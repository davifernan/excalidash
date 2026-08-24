# Ownership target model (NIL-323 / NIL-341)

Status: implemented in PR 1 of NIL-323 (Team/Ownership model). Canvas Shell and
Team Home (NIL-342–347) build on this in PR 2.

## What "no team" meant

Before this change, `main` had no `Team` concept at all. Ownership was:

- `Drawing.userId` -- who controls a board (share it, move it, delete it)
- `Drawing.createdByUserId` -- who drew it
- `Collection.userId` -- who owns a folder
- `DrawingPermission` / `CollectionShare` -- direct grants
- `Library` -- keyed literally as `user_${userId}`

There was nowhere to answer "who is on my team" or "what does a role mean
here" as a single question. Application code answered it ad hoc, and not
always the same way twice -- see "The `isOwner` naming problem" below.

## Why the model is small

ExcaliDash is built for **one team of about ten people per self-hosted
install**. Multi-tenant workspaces are an explicit product non-goal (see
`docs/product/PRODUCT_VISION.md`, "Enterprise-Mandantenfaehigkeit"). So the
target model does not introduce a workspace-switcher, invite-to-workspace
flow, or per-resource `teamId` column -- there is exactly one team, and every
resource in a self-hosted instance already belongs to it implicitly.

What the model *does* add:

### `Team` (singleton)

One row, fixed id `"default"`, seeded by its migration -- same pattern as
`SystemConfig`. It exists as a stable anchor (a name to show in Team Home, a
place for `NIL-326`'s Team Library to attach to later) and as the vocabulary
boundary: `backend/src/authz/team.ts` is now the one place that answers "who
is on the team, and with what role."

### Membership: derived, not stored

There is deliberately **no** `TeamMembership` table. An account is a team
member for exactly as long as `User.isActive` says so. A second table
recording the same fact would be a second copy of it -- and this project
already paid for that mistake once: `ACCESS_RANK` lived in three files before
NIL-487 collapsed it into one, and the two forgotten copies silently sorted an
unrecognized grant level as "no access." A membership table that needs to be
remembered at every one of the ~4 user-creation call sites (registration,
admin-create, OIDC JIT, bootstrap) is the same shape of risk. `User.isActive`
is already the single, carefully-guarded authority for "can this account
currently act" (`countActiveAdmins`, offboarding, socket revocation all rely
on it) -- team membership rides on that authority instead of duplicating it.

### Role: `User.role`, read through a named vocabulary

Likewise, there is no independent, assignable "team role." `User.role`
(`"ADMIN" | "USER"`) already carries real authority in this codebase
(impersonation, user management, the "at least one active admin" invariant) --
that authority *is* what "team owner" means here. `authz/team.ts` names it
(`TeamRole = "owner" | "member"`, `teamRoleFromUserRole`) so the rest of the
codebase has a team vocabulary to read, without a second role column that
would need to be kept in sync with the first by hand at every call site that
changes it.

If a future package needs team roles that are genuinely independent of
instance administration (e.g. a "can invite" role that is not also "can
impersonate"), that is a real product decision for that package to make
explicitly -- not something to pre-build here on spec.

## Board Owner vs. Creator

Unchanged, and reaffirmed as the deliberate design it already was:
`Drawing.userId` (owner/control) and `Drawing.createdByUserId` (creator) are
separate on purpose. A board drawn inside someone else's collection is
controlled by the collection's owner, not by whoever drew it. See the
column-level comments in `schema.prisma` and `authz/boards.ts`.

## Collection as organization, not an accidental rights source

A `Collection`'s owner automatically gets owner-level *access* to every board
inside it (`getDrawingAccess` in `authz/sharing.ts`). This is unchanged
behavior, called out here because NIL-341 asked for it to be an explicit,
acknowledged design decision rather than an accident of the query: a
collection is the team's organizational unit, and administering it
(renaming, sharing, deleting) is inseparable from controlling what is inside
it. `authz/collections.ts` and `authz/boards.ts` already model this as two
distinct questions (`controlsCollection` vs. board-level `controlsDrawing`)
that happen to compose this way by design.

## Share / guest access vs. team role

A `DrawingLinkShare` holder is explicitly a guest, not a team member:
`authz/membership.ts` never consults link shares when answering "who has a
standing claim on this board," and `authz/roster.ts` never lists them. This
was already correct and is unchanged -- documented here because NIL-341 asked
the relationship between share/guest access and team role to be explicit.

## Offboarding and ownerless boards

Two paths change an account's active status, and both now guarantee a
departing member leaves no ownerless or unreachable team resource behind
(NIL-341 acceptance criterion):

- **Full deletion** (`userOffboarding.ts`, admin-only, requires an explicit
  successor or the company-archive account): boards are reassigned and
  detached from the departing account's collections, because those
  collections are cascade-deleted along with the account in the same
  transaction.

  One case was left out of this PR's own review and closed later, under
  NIL-300: `transferOwnedBoards` was called here without `excludeTrash`, so a
  board the departing account had already thrown away (`collectionId:
  trash:<userId>`) was reassigned like any other -- `detachFromCollection`'s
  default then nulled its `collectionId`, and it resurfaced in the
  successor's "All Drawings" as a live, organized board. `boards.test.ts`
  carried this as a test literally named "unreviewed full-offboarding path"
  until NIL-300 reviewed it: full deletion now passes `excludeTrash: true`,
  same as plain deactivation below. A trashed board is left pointing at the
  departing account and is removed permanently by `Drawing.user`'s
  `onDelete: Cascade` a few lines later, alongside the identity that trashed
  it -- it does not reappear for the successor. This is a deliberate
  difference from every *other* board of the departing account: those are
  retained; already-discarded ones are not resurrected by an identity
  deletion that was never meant to undo the account's own delete action.
- **Plain deactivation** (`PATCH /users/:id { isActive: false }`): the account
  row survives, so its collections do *not* cascade away -- before this PR
  they were silently left owned by an account that could no longer log in to
  administer them, which is exactly the "unzugaengliches Teamboard" the
  acceptance criterion names. Deactivation now reassigns the departing
  member's owned boards *and* collections to the acting admin (who is, by
  definition, an active team member at the moment of the request), inside the
  same transaction as the deactivation and credential revocation. Boards keep
  their place inside their collection here -- unlike full deletion, nothing is
  being cascade-removed, so there is no need to detach them.
  `authz/boards.ts`'s `transferOwnedBoards` grew a `detachFromCollection`
  option (default `true`, preserving the existing full-deletion behavior) and
  a new `transferOwnedCollections` sibling for exactly this.

## The `isOwner` naming problem (NIL-489)

`isOwner` carried three different answers across the codebase:

- `routes/dashboard/drawingReadRoutes.ts` computed the *creator* claim
  (`isBoardCreator`) but named the local variable `isOwner`. Renamed to
  `isCreator` in this PR; behavior is unchanged, the function called was
  already correct.
- `routes/dashboard/collections.ts` genuinely means "owns this collection" --
  correct as-is, since `Collection` has no owner/creator split.
- `frontend/src/components/Sidebar.tsx` (and `CollectionTeamBar.tsx`,
  `useDashboardDrawingActions.ts`) treated `Collection.isOwner` as an
  optional three-state value (`true | false | undefined`), with `undefined`
  meaning "owned" everywhere it appeared -- via `!== false` / `=== false`
  comparisons that only worked because of that convention, not because the
  type said so. The backend has always set `isOwner` as a real boolean on
  every collection it returns; the frontend type just claimed otherwise. This
  PR makes `Collection.isOwner` a required `boolean` and simplifies every
  read site to a plain boolean check -- a yes/no question no longer needs
  three states to answer.

## What this PR deliberately does not do

- No `Library.teamId` migration. NIL-326 ("Team Library not bound to an
  individual account") owns that decision; this PR only establishes that
  `Team` exists as the anchor it would attach to.
- No Team Home UI, board switcher, command palette, or canvas-shell context
  chrome -- that is NIL-323's second PR (NIL-342–347), built once this model
  is in `main`.
- No team-role management UI. There is nothing to manage yet: team role is
  read from `User.role`, which the existing admin user-management screen
  already edits.
