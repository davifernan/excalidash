import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { stacking } from "../../../integrations/excalidraw/stacking";
import { CommentPanel } from "./CommentPanel";

const renderPanel = (
  onCreateThread = vi.fn().mockResolvedValue(undefined),
  onCanvasKeyDown = vi.fn(),
) =>
  render(
    <MemoryRouter>
      <div onKeyDown={onCanvasKeyDown}>
        <CommentPanel
          open
          onClose={vi.fn()}
          threads={[]}
          loading={false}
          candidates={[]}
          currentUserId="user-1"
          canComment
          canModerate={false}
          isPlacing={false}
          draftAnchor={null}
          onBeginPlacing={vi.fn()}
          onCancelPlacing={vi.fn()}
          onClearDraftAnchor={vi.fn()}
          onUseSelectionAsAnchor={vi.fn()}
          hasSelection={false}
          onCreateThread={onCreateThread}
          onReply={vi.fn().mockResolvedValue(undefined)}
          onEdit={vi.fn().mockResolvedValue(undefined)}
          onDelete={vi.fn().mockResolvedValue(undefined)}
          onResolve={vi.fn().mockResolvedValue(undefined)}
          onReopen={vi.fn().mockResolvedValue(undefined)}
          activeThreadId={null}
        />
      </div>
    </MemoryRouter>,
  );

describe("CommentPanel composer", () => {
  it("keeps its interactive surface above Excalidraw's chrome layer", () => {
    renderPanel();

    expect(screen.getByTestId("comment-panel").style.zIndex).toBe(stacking.anchoredOverlay);
  });

  it("sends with Enter, keeps Shift+Enter for a newline, and isolates canvas shortcuts", async () => {
    const onCreateThread = vi.fn().mockResolvedValue(undefined);
    const onCanvasKeyDown = vi.fn();
    renderPanel(onCreateThread, onCanvasKeyDown);
    const composer = screen.getByTestId("new-comment-input");

    fireEvent.change(composer, { target: { value: "Ship it" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(onCreateThread).toHaveBeenCalledWith("Ship it", null));
    expect(onCanvasKeyDown).not.toHaveBeenCalled();

    fireEvent.keyDown(composer, { key: "Enter", shiftKey: true });
    expect(onCreateThread).toHaveBeenCalledTimes(1);
    expect(onCanvasKeyDown).not.toHaveBeenCalled();
  });
});
