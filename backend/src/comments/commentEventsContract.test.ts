import { describe, expect, it } from "vitest";
import {
  COMMENT_CREATED_EVENT as DOMAIN_CREATED_EVENT,
  COMMENT_UPDATED_EVENT as DOMAIN_UPDATED_EVENT,
  COMMENT_DELETED_EVENT as DOMAIN_DELETED_EVENT,
} from "@excalidash/domain/collaboration";
import {
  COMMENT_CREATED_EVENT,
  COMMENT_UPDATED_EVENT,
  COMMENT_DELETED_EVENT,
  publishCommentCreated,
  publishCommentUpdated,
  publishCommentDeleted,
} from "./commentEvents";

/**
 * Backend half of the cross-runtime behavioral proof for the comment
 * live-update wire contract (NIL-637, Zweig B, comments domain, slice 1).
 *
 * `commentRoutes.ts` used to `io.to(...).emit("comment-created", ...)`
 * inline, five times across the file, each a hand-typed literal with no
 * comment claiming it had to match `useComments.ts`'s own hand-typed
 * `socket.on("comment-created", ...)`. Pulling the broadcast step out into
 * `publishCommentCreated`/`publishCommentUpdated`/`publishCommentDeleted`
 * makes it something this test can call directly, the same reason
 * `socketDrawingName.ts` keeps `publishDrawingName` standalone rather than
 * inline in a route.
 *
 * This drives the real backend publish functions against a fake `io` that
 * only records what was emitted and asserts the emitted event/room/payload.
 * It deliberately does not simulate a frontend socket listener -- that would
 * be a fabricated stand-in for `useComments.ts`, not a real one. The
 * frontend half of this contract lives in
 * `frontend/src/pages/editor/comments/useComments.test.ts`'s "does not
 * duplicate the author's own comment" test, which renders the REAL hook and
 * drives it through `COMMENT_CREATED_EVENT` from
 * `@excalidash/domain/collaboration` -- the same binding asserted below.
 */

const fakeIo = () => {
  const emitted: { room: string; event: string; payload: unknown }[] = [];
  return {
    emitted,
    io: {
      to: (room: string) => ({
        emit: (event: string, payload: unknown) => {
          emitted.push({ room, event, payload });
        },
      }),
    },
  };
};

describe("comment live-update wire contract", () => {
  it("all three re-exported event names are the identical domain binding, not a re-declared copy", () => {
    expect(COMMENT_CREATED_EVENT).toBe(DOMAIN_CREATED_EVENT);
    expect(COMMENT_UPDATED_EVENT).toBe(DOMAIN_UPDATED_EVENT);
    expect(COMMENT_DELETED_EVENT).toBe(DOMAIN_DELETED_EVENT);
  });

  it("publishCommentCreated emits the domain event name and the exact comment payload", () => {
    const { io, emitted } = fakeIo();
    const comment = { id: "c1" } as never;
    publishCommentCreated(io, "drawing-1", comment);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].event).toBe(COMMENT_CREATED_EVENT);
    expect(emitted[0].payload).toBe(comment);
  });

  it("publishCommentUpdated and publishCommentDeleted emit their own distinct event names", () => {
    const { io, emitted } = fakeIo();
    publishCommentUpdated(io, "drawing-1", { id: "c1" } as never);
    publishCommentDeleted(io, "drawing-1", "c1");

    expect(emitted.map((e) => e.event)).toEqual([COMMENT_UPDATED_EVENT, COMMENT_DELETED_EVENT]);
    expect(emitted[1].payload).toEqual({ id: "c1" });
  });
});
