import { describe, expect, it } from "vitest";
import {
  AgentContextValidationError,
  assertPersistedAgentContextFrames,
  validateContextFrames,
} from "./boardContexts";

const frame = (id: string, x: number, y = 0) => ({
  id,
  type: "frame",
  x,
  y,
  width: 100,
  height: 100,
  angle: 0,
  isDeleted: false,
});

describe("authoritative Agent Context frames", () => {
  it("forbids overlapping Context frames instead of resolving their intersection", () => {
    expect(() =>
      validateContextFrames(
        [frame("frame-a", 0), frame("frame-b", 50)],
        [
          { id: "context-a", frameElementId: "frame-a", pinned: false },
          { id: "context-b", frameElementId: "frame-b", pinned: false },
        ],
      ),
    ).toThrowError(
      expect.objectContaining<Partial<AgentContextValidationError>>({
        code: "CONTEXT_FRAMES_OVERLAP",
      }),
    );
  });

  it("allows frames that merely touch and rejects a missing/deleted frame", () => {
    expect(
      validateContextFrames(
        [frame("frame-a", 0), frame("frame-b", 100)],
        [
          { id: "context-a", frameElementId: "frame-a", pinned: false },
          { id: "context-b", frameElementId: "frame-b", pinned: false },
        ],
      ).size,
    ).toBe(2);
    expect(() =>
      validateContextFrames(
        [frame("frame-a", 0)],
        [{ id: "context-b", frameElementId: "frame-b", pinned: false }],
      ),
    ).toThrowError(expect.objectContaining({ code: "CONTEXT_FRAME_MISSING" }));
  });

  it("guards later scene mutations using the persisted Context map", async () => {
    const calls: string[] = [];
    const prisma = {
      $executeRaw: async () => {
        calls.push("lock-drawing");
        return 1;
      },
      agentContext: {
        findMany: async () => {
          calls.push("read-contexts");
          return [
            { id: "context-a", frameElementId: "frame-a", pinned: false },
            { id: "context-b", frameElementId: "frame-b", pinned: false },
          ];
        },
      },
    };
    await expect(
      assertPersistedAgentContextFrames(prisma, "drawing-1", [
        frame("frame-a", 0),
        frame("frame-b", 50),
      ]),
    ).rejects.toMatchObject({ code: "CONTEXT_FRAMES_OVERLAP" });
    expect(calls).toEqual(["lock-drawing", "read-contexts"]);
  });

  it("fails closed when the shared Drawing lock cannot find the board", async () => {
    const prisma = {
      $executeRaw: async () => 0,
      agentContext: { findMany: async () => [] },
    };
    await expect(
      assertPersistedAgentContextFrames(prisma, "missing", [frame("frame-a", 0)]),
    ).rejects.toMatchObject({ code: "CONTEXT_FRAME_MISSING" });
  });
});
