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
    const prisma = {
      agentContext: {
        findMany: async () => [
          { id: "context-a", frameElementId: "frame-a", pinned: false },
          { id: "context-b", frameElementId: "frame-b", pinned: false },
        ],
      },
    };
    await expect(
      assertPersistedAgentContextFrames(prisma, "drawing-1", [
        frame("frame-a", 0),
        frame("frame-b", 50),
      ]),
    ).rejects.toMatchObject({ code: "CONTEXT_FRAMES_OVERLAP" });
  });
});
