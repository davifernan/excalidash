import { describe, expect, it } from "vitest";
import { CURSOR_CHAT_MAX_LENGTH } from "@excalidash/domain/collaboration";
import { CURSOR_CHAT_LIMITS } from "./socketCursorChat";

describe("cursor chat protocol contract", () => {
  it("takes the enforced cap from the shared domain contract", () => {
    expect(CURSOR_CHAT_LIMITS.textLength).toBe(CURSOR_CHAT_MAX_LENGTH);
  });
});
