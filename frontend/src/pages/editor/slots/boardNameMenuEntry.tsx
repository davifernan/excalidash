/**
 * The board name, editable, as the first line of the hamburger.
 *
 * NIL-376: this used to be its own floating island in the top-left corner,
 * portalled straight into Excalidraw's root. The island is gone -- along with
 * the second "back to dashboard" it duplicated (NIL-374) -- and the name
 * moved in here instead. It is also this package's worked example for the
 * slot contract in chromeSlots.tsx: a package with an entry point to add
 * writes a component like this one, in its own file, and lists it in that
 * file's registry. Nothing outside chromeSlots.tsx and this file changes.
 *
 * Rename state (`isRenaming`, `newName`, the three handlers) still lives in
 * Editor.tsx, same as before the island: this component reads it off
 * `ChromeSlotContext` rather than owning it, the same way every other slot
 * entry reads whatever field of the context it needs.
 */
import { LockKeyhole, Pencil } from "lucide-react";
import type { ChromeSlotContext } from "../chromeSlots";
import "./boardNameMenuEntry.css";

export const BoardNameMenuEntry = ({ ctx }: { ctx: ChromeSlotContext }) => {
  if (ctx.isRenaming) {
    return (
      <form onSubmit={ctx.onRenameSubmit} className="board-name-menu-entry">
        <Pencil size={16} aria-hidden />
        <input
          autoFocus
          type="text"
          value={ctx.newName}
          onChange={(event) => ctx.onNewNameChange(event.target.value)}
          onBlur={ctx.onRenameBlur}
          aria-label="Drawing name"
          data-testid="menu-board-name-input"
          className="board-name-menu-entry__input"
        />
      </form>
    );
  }

  return (
    <button
      type="button"
      className="board-name-menu-entry"
      onClick={ctx.canEdit ? ctx.onRenameStart : undefined}
      title={ctx.canEdit ? `${ctx.drawingName} — click to rename` : ctx.drawingName}
      data-testid="menu-board-name"
      disabled={!ctx.canEdit}
    >
      {ctx.canEdit ? <Pencil size={16} aria-hidden /> : <LockKeyhole size={16} aria-hidden />}
      <span className="board-name-menu-entry__value">{ctx.drawingName}</span>
      {!ctx.canEdit ? <span className="board-name-menu-entry__status">Read-only</span> : null}
    </button>
  );
};
