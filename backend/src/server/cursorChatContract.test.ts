import { describe, expect, it } from "vitest";
import { bindCursorChat } from "../../../frontend/src/pages/editor/cursorChat";
import { CURSOR_CHAT_LIMITS } from "./socketCursorChat";

describe("cursor chat protocol contract", () => {
  it("keeps the frontend's emitted draft within the backend-enforced cap", () => {
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const controller = bindCursorChat({
      drawingId: "drawing-1",
      socket: {
        emit: (event, payload) => emitted.push({ event, payload }),
        on: () => undefined,
        off: () => undefined,
      },
      onRemoteChange: () => undefined,
      onDraftChange: () => undefined,
    });

    controller.open();
    controller.type("x".repeat(CURSOR_CHAT_LIMITS.textLength + 20));
    controller.dispose();

    expect(emitted).toHaveLength(1);
    expect(
      (emitted[0].payload as { text: string }).text,
      "the frontend-emitted text must equal the backend-enforced cursor-chat cap",
    ).toHaveLength(CURSOR_CHAT_LIMITS.textLength);
  });
});
