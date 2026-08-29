# Element guest provenance

NIL-695 supplies the element-level fact consumed by the Agent Context guest policy. It does not
decide that policy: instance and board capability decisions remain in
`backend/src/authz/capabilities.ts`.

## Three states, one Boolean column

`DrawingElementGuestProvenance` is a side table keyed by `(drawingId, elementId)`. Elements stay
inside the drawing JSON; the table deliberately has no foreign key to an element row that does
not exist.

The complete state is:

| Stored value               | Meaning                                                                             |
| -------------------------- | ----------------------------------------------------------------------------------- |
| no row                     | `unknown` — normally legacy content; never equivalent to clean                      |
| `everGuestTouched = false` | `confirmed-clean` — server-observed member creation or explicit member confirmation |
| `everGuestTouched = true`  | `guest-touched` — at least one admitted guest mutation                              |

An authorization consumer fails closed for `unknown` exactly as it does for `guest-touched`,
unless the current board policy explicitly permits guest contribution. This is why the migration
does not backfill `false`: existing authorship cannot be reconstructed.

## Mutation and reset rules

- An admitted link-guest Socket.IO element update records `true` before it is broadcast. A
  refused update records nothing.
- A version-checked HTTP scene replacement, history restore, or semantic operation records the
  elements it actually changed. The actor is treated as a guest if either the pre-write or the
  in-transaction capability decision says guest, so a membership transition cannot wash the
  event through a TOCTOU window.
- Ordinary member edits never update an existing provenance row. In particular, moving or
  editing a guest-touched element cannot clear it. A member-created element may create a new
  `false` row when the server can prove that the id did not exist in the previous scene.
- A history restore never treats a reappearing element as member-created. If it has no row, it
  stays `unknown`; restoring an old snapshot cannot manufacture clean provenance for content
  whose author the snapshot does not record.
- Context registration is the deliberate materialization boundary for legacy uncertainty. Every
  still-unknown element in the registered frame is persisted as `guest-touched`, and the response
  names all non-clean elements as `provenanceReview.elementIdsRequiringConfirmation`. This does
  not claim a known guest identity; it fixes the unknown fact in its conservative authorization
  state so absence can never later be mistaken for clean. Only the audited human reset may clear
  it.
- The only reset is the human endpoint
  `POST /drawings/:id/element-guest-provenance/confirm-clean`. It requires a current, non-guest
  editor, accepts only live elements in a registered Agent Context, rejects agent API keys, and
  emits `element_guest_provenance_confirmed_clean` through the audit seam. Its per-row revision
  makes a concurrent guest touch win rather than letting a stale human confirmation erase it.

Element membership follows explicit `frameId` ancestry. Geometry never turns proximity into
Context membership.
