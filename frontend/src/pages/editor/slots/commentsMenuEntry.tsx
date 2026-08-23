/**
 * The comments entry point, in both places `ChromeSlotContext` gives it a
 * home.
 *
 * NIL-324's worked example for the slot contract in chromeSlots.tsx (see
 * boardNameMenuEntry.tsx for the original one): a package with an entry
 * point writes it here, in its own file, and lists it in chromeSlots.tsx's
 * registries. Nothing outside chromeSlots.tsx and this file changes for it.
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
import { MessageSquare } from "lucide-react";
import type { ChromeSlotContext } from "../chromeSlots";

/** The registry entry in chromeSlots.tsx already guards accessLevel/id
 * before this renders -- inline there, not delegated here, the same way
 * share/invite guard themselves: an entry.render(ctx) that always returns
 * an element (even one that renders null internally) breaks the "hidden
 * means render() === null" convention chromeSlots.test.tsx relies on. */
export const CommentsHeaderControl = ({ ctx }: { ctx: ChromeSlotContext }) => (
  <button
    onClick={ctx.onToggleComments}
    className="editor-header-control"
    data-active={ctx.isCommentsOpen || undefined}
    title="Comments"
    aria-label={
      ctx.unresolvedCommentCount > 0
        ? `Comments; ${ctx.unresolvedCommentCount} unresolved`
        : "Comments"
    }
    aria-pressed={ctx.isCommentsOpen}
    data-testid="editor-comments-toggle"
  >
    <MessageSquare size={16} />
    {ctx.unresolvedCommentCount > 0 ? (
      <span className="editor-header-control__badge">{ctx.unresolvedCommentCount}</span>
    ) : null}
  </button>
);

/** The menu item's label. The registry entry in chromeSlots.tsx already
 * guards accessLevel/id before this renders. */
export const CommentsMenuEntry = ({ ctx }: { ctx: ChromeSlotContext }) => (
  <>
    {ctx.isCommentsOpen ? "Hide comments" : "Comments"}
    {ctx.unresolvedCommentCount > 0 ? ` (${ctx.unresolvedCommentCount})` : ""}
  </>
);
