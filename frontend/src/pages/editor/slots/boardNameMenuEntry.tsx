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
import type React from "react";
import type { ChromeSlotContext } from "../chromeSlots";

const row: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.125rem",
  width: "100%",
  padding: "0.25rem 0",
};

export const BoardNameMenuEntry = ({ ctx }: { ctx: ChromeSlotContext }) => {
  if (ctx.isRenaming) {
    return (
      <form onSubmit={ctx.onRenameSubmit} style={row}>
        <input
          autoFocus
          type="text"
          value={ctx.newName}
          onChange={(event) => ctx.onNewNameChange(event.target.value)}
          onBlur={ctx.onRenameBlur}
          aria-label="Drawing name"
          data-testid="menu-board-name-input"
          style={{
            font: "inherit",
            fontWeight: 600,
            padding: "0.25rem 0.4rem",
            borderRadius: "var(--border-radius-md, 0.375rem)",
            border: "1px solid var(--color-primary, #6965db)",
            background: "transparent",
            color: "inherit",
            outline: "none",
            width: "100%",
          }}
        />
      </form>
    );
  }

  return (
    <div
      style={row}
      onDoubleClick={ctx.canEdit ? ctx.onRenameStart : undefined}
      title={ctx.canEdit ? `${ctx.drawingName} — double-click to rename` : ctx.drawingName}
      data-testid="menu-board-name"
    >
      <span
        style={{
          fontWeight: 600,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          cursor: ctx.canEdit ? "text" : "default",
        }}
      >
        {ctx.drawingName}
      </span>
      {!ctx.canEdit ? (
        <span style={{ fontSize: "0.6875rem", opacity: 0.65 }}>Read-only</span>
      ) : null}
    </div>
  );
};
