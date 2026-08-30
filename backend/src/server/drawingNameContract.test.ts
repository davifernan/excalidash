import { describe, expect, it } from "vitest";
import {
  DRAWING_NAME_EVENT as DOMAIN_DRAWING_NAME_EVENT,
  MAX_DRAWING_NAME_LENGTH,
} from "@excalidash/domain/collaboration";
import { DRAWING_NAME_EVENT } from "./socketDrawingName";
import { drawingBaseSchema } from "../index";
import { bindSocketDrawingName } from "../../../frontend/src/pages/editor/drawingName";

/**
 * Cross-runtime behavioral proof for the drawing-name-update wire contract
 * (NIL-637, Zweig B, collaboration sockets domain slice 1).
 *
 * Before this, `DRAWING_NAME_EVENT` and the length cap were each declared
 * independently on both sides -- and the cap specifically had no comment
 * anywhere claiming the two 255s had to match, unlike cursor chat's own
 * "matches the server's cap" comment (NIL-637's earlier slice). This is
 * the quieter version of the same risk: two numbers that happened to
 * agree, with nothing enforcing it and nothing even asserting it should
 * hold.
 *
 * `drawingBaseSchema` is imported directly from `../index` (exported for
 * exactly this, following the same precedent as
 * `sanitizeDrawingUpdateData` in preview-update-regression.test.ts) rather
 * than re-implemented here, so this proves the REST-side validation
 * actually in production, not a schema that merely looks like it.
 */

describe("drawing name wire contract", () => {
  it("both sides re-export the same domain event name, not a re-declared copy", () => {
    expect(DRAWING_NAME_EVENT).toBe(DOMAIN_DRAWING_NAME_EVENT);
  });

  it("the REST create/update schema accepts a name exactly at the shared cap and rejects one over it", () => {
    const atCap = "x".repeat(MAX_DRAWING_NAME_LENGTH);
    const overCap = "x".repeat(MAX_DRAWING_NAME_LENGTH + 1);
    expect(drawingBaseSchema.safeParse({ name: atCap }).success).toBe(true);
    expect(drawingBaseSchema.safeParse({ name: overCap }).success).toBe(false);
  });

  it("the frontend accepts a live-update name exactly at the shared cap and rejects one over it", () => {
    const drawingId = "drawing-1";
    const handlers = new Map<string, (payload: unknown) => void>();
    const socket = {
      emit: () => {},
      on: (event: string, handler: (payload: unknown) => void) => handlers.set(event, handler),
      off: () => {},
    };
    const received: string[] = [];
    bindSocketDrawingName({
      socket: socket as never,
      drawingId,
      onChange: (name) => received.push(name),
    });

    const atCap = "y".repeat(MAX_DRAWING_NAME_LENGTH);
    const overCap = "y".repeat(MAX_DRAWING_NAME_LENGTH + 1);
    handlers.get(DRAWING_NAME_EVENT)?.({ drawingId, name: atCap, revision: 1 });
    handlers.get(DRAWING_NAME_EVENT)?.({ drawingId, name: overCap, revision: 2 });

    expect(received).toEqual([atCap]);
  });
});
