/**
 * The board's organizational context, right under its name in the hamburger.
 *
 * NIL-323/NIL-344: "sichtbarer Boardname und Workspacekontext" -- board name
 * is NIL-376's (BoardNameMenuEntry, just above this in the menu); this is
 * the other half. Renders nothing when `collectionId` is null, which covers
 * two different reasons on purpose (the entry does not need to tell them
 * apart): the board is genuinely unorganized, or the viewer is not the
 * creator and the backend never sent collection data at all (see
 * chromeSlots.tsx's "Growing the context" section, and
 * drawingReadRoutes.ts). Either way, an absent line reads as "no context to
 * show" -- silence, not a broken or misleading one.
 */
import type React from "react";
import { Folder } from "lucide-react";
import type { ChromeSlotContext } from "../chromeSlots";

const row: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.3rem",
  width: "100%",
  padding: "0 0 0.375rem",
  fontSize: "0.75rem",
  opacity: 0.65,
};

export const WorkspaceContextMenuEntry = ({ ctx }: { ctx: ChromeSlotContext }) => {
  if (!ctx.collectionId || !ctx.collectionName) return null;

  return (
    <div style={row} data-testid="menu-workspace-context">
      <Folder size={12} aria-hidden="true" />
      <span
        style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        title={ctx.collectionName}
      >
        {ctx.collectionName}
      </span>
    </div>
  );
};
