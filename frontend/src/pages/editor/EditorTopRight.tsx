/**
 * The header control group: Follow/avatars, Invite, Share, Library.
 *
 * NIL-376: this used to be two boxes -- our own grey island (Invite, Share)
 * sitting a visible gap away from Excalidraw's own white Library trigger, with
 * Excalidraw's collaborator avatars further left again. `editorChrome.css`
 * merges all three into one flush grey bar by styling the shared ancestor
 * Excalidraw itself renders, `.layer-ui__wrapper__top-right` -- the same kind
 * of known, visible dependency on Excalidraw's own markup that
 * useExcalidrawUiState.ts already takes on for zen mode and the mobile
 * breakpoint, not a new category of risk.
 *
 * Invite and Share are now `HeaderControlSlotEntry` entries from
 * chromeSlots.tsx rather than hardcoded here, alongside a duplicate route to
 * each in the hamburger (MAIN_MENU_ENTRIES) for when this whole group stands
 * down on mobile -- see the follow-up paragraph below.
 *
 * `renderTopRightUI` is the slot Excalidraw offers for exactly this, sitting
 * between the avatar list and the Library trigger.
 */
import { renderHeaderControlEntries, type ChromeSlotContext } from "./chromeSlots";

export const EditorTopRight = ({
  isMobile,
  followerNotice,
  ctx,
}: {
  isMobile: boolean;
  followerNotice: string | null;
  ctx: ChromeSlotContext;
}) => {
  // Excalidraw's mobile tool row already fills the width -- an island beside
  // it pushes tools off the screen. The same actions live in the hamburger
  // there instead (MAIN_MENU_ENTRIES: invite-everyone-here, share), which is
  // the one place that exists at every window size.
  if (isMobile) return null;

  return (
    <div className="editor-header-controls" data-testid="editor-top-right">
      {followerNotice ? (
        <span
          className="editor-header-controls__notice"
          data-testid="editor-follower-notice"
          title={followerNotice}
        >
          {followerNotice}
        </span>
      ) : null}
      {renderHeaderControlEntries(ctx)}
    </div>
  );
};
