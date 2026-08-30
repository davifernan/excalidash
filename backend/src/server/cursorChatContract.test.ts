import { describe, expect, it } from "vitest";
import {
  CURSOR_CHAT_EVENT as DOMAIN_CURSOR_CHAT_EVENT,
  CURSOR_CHAT_TEXT_MAX_LENGTH,
} from "@excalidash/domain/collaboration";
import { CURSOR_CHAT_EVENT, CURSOR_CHAT_LIMITS, parseCursorChatPayload } from "./socketCursorChat";
import {
  bindCursorChat,
  CURSOR_CHAT_EVENT as FRONTEND_CURSOR_CHAT_EVENT,
  CURSOR_CHAT_MAX_LENGTH,
} from "../../../frontend/src/pages/editor/cursorChat";

/**
 * Cross-runtime behavioral proof for cursor chat's wire contract (NIL-637,
 * Zweig B).
 *
 * The old version of this test (before this commit) read the frontend's
 * source text with a regex, looking for a literal `export const
 * CURSOR_CHAT_MAX_LENGTH = (\d+);` declaration -- it checked the wording,
 * not the enforcement: it would have passed even if the frontend never
 * actually used that constant anywhere, and it broke the moment the
 * frontend stopped declaring its own literal (this commit's own change)
 * even though the contract it exists to protect held. This version
 * imports the real server module and the real frontend module and drives
 * their actual functions, the same shape as
 * customDataWidget.contract.test.ts.
 */

const drawingId = "11111111-2222-3333-4444-555555555555";

const makeSocket = () => {
  const handlers = new Map<string, (payload: unknown) => void>();
  const sent: { event: string; payload: unknown }[] = [];
  return {
    sent,
    handlers,
    socket: {
      emit: (event: string, payload: unknown) => sent.push({ event, payload }),
      on: (event: string, handler: (payload: unknown) => void) => handlers.set(event, handler),
      off: (event: string) => handlers.delete(event),
    },
  };
};

describe("cursor chat wire contract", () => {
  it("both sides re-export the same domain constants, not a re-declared copy", () => {
    expect(CURSOR_CHAT_EVENT).toBe(DOMAIN_CURSOR_CHAT_EVENT);
    expect(FRONTEND_CURSOR_CHAT_EVENT).toBe(DOMAIN_CURSOR_CHAT_EVENT);
    expect(CURSOR_CHAT_LIMITS.textLength).toBe(CURSOR_CHAT_TEXT_MAX_LENGTH);
    expect(CURSOR_CHAT_MAX_LENGTH).toBe(CURSOR_CHAT_TEXT_MAX_LENGTH);
  });

  it("the server accepts a message exactly at the cap and rejects one over it", () => {
    const atCap = "x".repeat(CURSOR_CHAT_TEXT_MAX_LENGTH);
    const overCap = "x".repeat(CURSOR_CHAT_TEXT_MAX_LENGTH + 1);
    expect(parseCursorChatPayload({ drawingId, text: atCap })).toEqual({
      drawingId,
      text: atCap,
    });
    expect(parseCursorChatPayload({ drawingId, text: overCap })).toBeNull();
  });

  it("the frontend truncates its own draft to exactly the server's cap, not a separately-remembered number", () => {
    const { socket, sent } = makeSocket();
    const chat = bindCursorChat({
      socket,
      drawingId: "board",
      onRemoteChange: () => {},
      onDraftChange: () => {},
    });
    chat.open();
    chat.type("x".repeat(CURSOR_CHAT_TEXT_MAX_LENGTH + 50));
    const lastSent = sent.at(-1) as { payload: { text: string } };
    expect(lastSent.payload.text).toHaveLength(CURSOR_CHAT_TEXT_MAX_LENGTH);
  });

  it("a message the server accepts at exactly the cap is displayed by the frontend in full, not re-truncated by a separate number", () => {
    const atCap = "y".repeat(CURSOR_CHAT_TEXT_MAX_LENGTH);
    const accepted = parseCursorChatPayload({ drawingId, text: atCap });
    expect(accepted).not.toBeNull();

    const { socket, handlers } = makeSocket();
    let remoteChanges = 0;
    const chat = bindCursorChat({
      socket,
      drawingId: "board",
      onRemoteChange: () => {
        remoteChanges += 1;
      },
      onDraftChange: () => {},
    });

    // Simulate the server relaying what it just accepted back over the wire,
    // exactly as registerCursorChatRoomEvent's `handle` callback does.
    handlers.get(CURSOR_CHAT_EVENT)?.({ presenceId: "presence-1", text: accepted?.text });

    expect(remoteChanges).toBe(1);
    expect(chat.remote.get("presence-1")).toBe(atCap);
    expect(chat.remote.get("presence-1")).toHaveLength(CURSOR_CHAT_TEXT_MAX_LENGTH);
    chat.dispose();
  });
});
