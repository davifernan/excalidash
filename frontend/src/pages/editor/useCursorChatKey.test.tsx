import { fireEvent, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useCursorChatKey } from "./useCursorChatKey";

describe("cursor-chat selection capability", () => {
  it("keeps the idle-canvas fallback when selection.read reports a failure", () => {
    const selection = {
      read: vi.fn(() => ({
        ok: false,
        code: "editor-changed",
        seam: "selection.read",
      })),
    } as any;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const open = vi.fn();

    const { unmount } = renderHook(() =>
      useCursorChatKey({
        containerRef: { current: container },
        enabled: true,
        selection,
        chatRef: { current: { open } as any },
      }),
    );

    fireEvent.keyDown(container, { key: "Enter" });

    expect(selection.read).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledOnce();
    unmount();
    container.remove();
  });
});
