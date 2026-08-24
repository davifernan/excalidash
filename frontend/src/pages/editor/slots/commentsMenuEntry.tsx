/**
 * The comments entry point: the hamburger-menu label `MAIN_MENU_ENTRIES`
 * renders.
 *
 * NIL-324's worked example for the slot contract in chromeSlots.tsx (see
 * boardNameMenuEntry.tsx for the original one): a package with an entry
 * point writes it here, in its own file, and lists it in chromeSlots.tsx's
 * registries. Nothing outside chromeSlots.tsx and this file changes for it.
 *
 * Menu-only, not also a `HeaderControlSlotEntry`: measured against a real
 * multi-collaborator session, a third header-control icon (alongside
 * invite/share) pushed Excalidraw's own collaborator-avatar list into its
 * "+N" collapsed state -- see chromeSlots.tsx's "comments" MAIN_MENU_ENTRIES
 * comment for the full measurement.
 *
 * The panel and canvas markers this toggles are not part of this contract --
 * they are a free-floating `ui.overlayRoot()` portal exactly like
 * WorkshopTimerCorner and InviteHereOverlay, rendered as a direct
 * `commentsOverlay` prop on EditorView (there is no generic overlay
 * registry yet; three overlays already work this way without one, and a
 * fourth does not justify inventing one for a single new consumer -- see
 * `OverlaySlotEntry`'s own doc comment on why it carries no `order`).
 * This file only owns the toggle.
 */
import type { ChromeSlotContext } from "../chromeSlots";

/** The menu item's label. The registry entry in chromeSlots.tsx already
 * guards accessLevel/id before this renders. */
export const CommentsMenuEntry = ({ ctx }: { ctx: ChromeSlotContext }) => (
  <>
    {ctx.isCommentsOpen ? "Hide comments" : "Comments"}
    {ctx.unresolvedCommentCount > 0 ? ` (${ctx.unresolvedCommentCount})` : ""}
  </>
);
