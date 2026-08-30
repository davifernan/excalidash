import { act, renderHook, waitFor } from "@testing-library/react";
import type { MutableRefObject } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Socket } from "socket.io-client";
import { COMMENT_CREATED_EVENT } from "@excalidash/domain/collaboration";
import { useComments } from "./useComments";
import type { CommentDTO } from "../../../api/comments";

const mocks = vi.hoisted(() => ({
  getDrawingComments: vi.fn(),
  getMentionCandidates: vi.fn(),
  createComment: vi.fn(),
}));

vi.mock("../../../api/comments", () => ({
  getDrawingComments: mocks.getDrawingComments,
  getMentionCandidates: mocks.getMentionCandidates,
  createComment: mocks.createComment,
}));

const makeComment = (overrides: Partial<CommentDTO> = {}): CommentDTO => ({
  id: "c1",
  drawingId: "d1",
  rootId: null,
  authorUserId: "alice",
  authorName: "Alice",
  body: "hello",
  elementId: null,
  anchorX: null,
  anchorY: null,
  resolvedAt: null,
  resolvedByUserId: null,
  editedAt: null,
  deletedAt: null,
  mentionedUserIds: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const makeSocket = () => {
  const handlers: Record<string, ((...args: any[]) => void)[]> = {};
  const socket = {
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      (handlers[event] ??= []).push(handler);
    }),
    off: vi.fn(),
  } as unknown as Socket;
  const emit = (event: string, payload: unknown) => {
    for (const handler of handlers[event] ?? []) handler(payload);
  };
  return { socket, emit };
};

describe("useComments", () => {
  it("does not fetch comments or subscribe to comment events when visibility is disabled", async () => {
    mocks.getDrawingComments.mockClear();
    mocks.getMentionCandidates.mockClear();
    const { socket } = makeSocket();
    const socketRef: MutableRefObject<Socket | null> = { current: socket };

    const { result } = renderHook(() =>
      useComments({ drawingId: "d1", enabled: false, canComment: true, socketRef, isReady: true }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mocks.getDrawingComments).not.toHaveBeenCalled();
    expect(mocks.getMentionCandidates).not.toHaveBeenCalled();
    expect(socket.on).not.toHaveBeenCalled();
  });

  /**
   * RED PROBE evidence (see PR HANDOFF): the server emits "comment-created"
   * to the whole drawing room -- including the author's own socket -- before
   * the HTTP response that createThread/reply is awaiting even returns, so
   * the echo reliably lands first. Before upsertComment, the socket handler
   * and the actor's own optimistic append each unconditionally added the row,
   * producing a duplicate entry (and duplicate React key) for the actor's own
   * comment specifically -- an observer never hit this path, only the author.
   *
   * This is also the frontend half of the comment live-update wire contract
   * (NIL-637, Zweig B, comments domain, slice 1): the emit below uses
   * `COMMENT_CREATED_EVENT` from `@excalidash/domain/collaboration`, the same
   * binding `useComments.ts` registers `socket.on` with, so this test drives
   * the REAL hook's REAL listener through the shared constant rather than a
   * coincidentally-matching literal. The backend half --
   * `backend/src/comments/commentEventsContract.test.ts` -- proves
   * `publishCommentCreated` emits that identical binding; neither half
   * fabricates the other side.
   */
  it("does not duplicate the author's own comment when its socket echo arrives before the HTTP response resolves", async () => {
    mocks.getDrawingComments.mockResolvedValue({ comments: [], canComment: true });
    mocks.getMentionCandidates.mockResolvedValue([]);

    const comment = makeComment();
    let resolveCreate!: (value: CommentDTO) => void;
    mocks.createComment.mockReturnValue(
      new Promise<CommentDTO>((resolve) => {
        resolveCreate = resolve;
      }),
    );

    const { socket, emit } = makeSocket();
    const socketRef: MutableRefObject<Socket | null> = { current: socket };

    const { result } = renderHook(() =>
      useComments({ drawingId: "d1", enabled: true, canComment: true, socketRef, isReady: true }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    let createPromise!: Promise<CommentDTO | undefined>;
    act(() => {
      createPromise = result.current.createThread("hello");
    });

    // The socket echo "arrives" first, exactly like the real race.
    act(() => {
      emit(COMMENT_CREATED_EVENT, comment);
    });
    expect(result.current.threads).toHaveLength(1);

    // Now the HTTP response the actor was actually waiting on resolves.
    await act(async () => {
      resolveCreate(comment);
      await createPromise;
    });

    expect(result.current.threads).toHaveLength(1);
    expect(result.current.threads[0].root.id).toBe("c1");
  });

  it("still adds the comment if the HTTP response resolves first and no echo ever arrives (e.g. a slow/offline socket)", async () => {
    mocks.getDrawingComments.mockResolvedValue({ comments: [], canComment: true });
    mocks.getMentionCandidates.mockResolvedValue([]);
    const comment = makeComment({ id: "c2" });
    mocks.createComment.mockResolvedValue(comment);

    const { socket } = makeSocket();
    const socketRef: MutableRefObject<Socket | null> = { current: socket };

    const { result } = renderHook(() =>
      useComments({ drawingId: "d1", enabled: true, canComment: true, socketRef, isReady: true }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.createThread("hello");
    });

    expect(result.current.threads).toHaveLength(1);
    expect(result.current.threads[0].root.id).toBe("c2");
  });
});
