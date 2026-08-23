# Comments guest policy (NIL-324 / NIL-353 / NIL-283)

Status: implemented in NIL-324 (M3: Comments, Activity, Notifications).

## The question

`getDrawingAccess` folds an active share-link token into a principal's
access, so a person holding only a URL -- no account, or an account with no
standing grant on the board -- can open a board at `"view"` or `"edit"`
level. NIL-283's research flagged commenting spiraling out of control as
Miro's most-cited own complaint, and every comment carries a real actor,
mentions, notifications, resolve/reopen state, and (for moderation) a
delete/edit trail. Does an anonymous link guest get to write any of that?

## The decision

**No. Commenting requires a real, authenticated account.** A link grants
*access* (what a principal may see or do to the board), never *authorship*.
`POST /drawings/:id/comments` (and edit/delete/resolve/reopen) sit behind
`requireAuth`, not `optionalAuth` -- there is no code path where
`principal.kind` is anything but `"user"` by the time a comment is written.

This is enforced at the route, not only assumed: `GET /drawings/:id/comments`
uses `optionalAuth` (so a link guest can still *read* the thread, matching
`"view"` access to the board itself) and reports
`canComment: canCommentDrawing(access) && principal?.kind === "user"`, so the
client never even offers the compose box to a guest -- but the write routes
enforce it again server-side regardless of what the client shows.

### Why not "let a link guest comment under a display name they type in"

Rejected. A typed display name is not an identity:

- **Mentions and notifications need someone to attach to.** `@[Name](userId)`
  tokens are re-resolved against the board roster
  (`extractMentionedUserIds` + `getDrawingRosters`); a guest has no roster
  entry to be mentioned, notified, or shown in the mention picker at all.
- **Moderation needs someone accountable.** `deleteComment`'s
  author-or-editor check and `editComment`'s author-only check both key off
  `authorUserId`, a real `User` row. A guest identity that resets every
  page load could not be held to either.
- **It reintroduces exactly the failure mode NIL-283 warned about.**
  Unattributable comments are the raw material of "comments got out of
  control" -- nothing to resolve against, nothing to filter by, nothing to
  offboard.

### "comment" is a distinct grantable level, not implied by "view"

`DrawingPermission` (NIL-487) already ordered `"comment"` between `"view"`
and `"edit"`: `canCommentDrawing(access)` is true only for
`"comment" | "edit" | "owner"`, false for `"view"`. NIL-324 does not change
that ordering -- it is the first PR to actually *grant* `"comment"`, in the
per-drawing Share dialog (`GeneralAccessSection`, `SharePeopleSection`) and
in link shares (`POST /drawings/:id/link-shares`).

Consequence: a board shared at `"view"` (the common default for "anyone with
the link can look") does **not** let its viewers comment, guest or
account-holder alike. A board owner who wants a reviewer to leave notes has
to explicitly grant `"comment"` (or `"edit"`) -- to that person directly, or
by issuing a link at `"comment"` level. This mirrors the reasoning already
in `authz/sharing.ts`: "Commenting is not a weak form of editing -- it must
not open a single write path that `"view"` does not already open," and the
same non-widening applies in the other direction: `"view"` does not imply
`"comment"` either.

### Link TTL groups "comment" with "view", not with "edit"

`resolveDefaultTtlMs` (backend/src/routes/dashboard/drawingRouteContext.ts)
already grouped `"comment"` with `"view"` for default link lifetime, with an
explicit comment: a leaked edit link can destroy work, a leaked comment link
cannot. NIL-324 found one inconsistent reader next to it --
`drawingSharingRoutes.ts`'s no-expiry eligibility branched on
`permission === "view"`, so an owner explicitly requesting a permanent
`"comment"` link silently got a forced expiry instead, the opposite of what
the sibling function's own reasoning says it should do. Fixed to group
`"comment"` with `"view"` there too (both may be issued with no expiry;
only `"edit"` cannot).

## What this does NOT decide

Collection-level sharing (`CollectionShare.role`, `RoleSelect.tsx`) stays
`"view" | "edit"` only in this PR. Extending it to `"comment"` is a real
option later, but it is a different surface with its own UI
(`ShareCollectionModal.tsx`) and no ticket in this package asked for it --
left as an explicit non-goal rather than silently half-done.
