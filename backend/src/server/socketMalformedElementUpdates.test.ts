import { describe, expect, it, vi } from "vitest";
import { BOOTSTRAP_USER_ID } from "../auth/authMode";
import { FakeIo } from "../__tests__/socketTestDoubles";
import { registerSocketHandlers } from "./socket";
import { SOCKET_LIMITS } from "./socketProtocol";

describe("element-update rejection policy", () => {
  it("disconnects repeated malformed oversized elements as hard failures", async () => {
    const io = new FakeIo();
    registerSocketHandlers({
      io: io as any,
      prisma: {
        drawing: { findUnique: vi.fn() },
        drawingLinkShare: { findFirst: vi.fn() },
      } as any,
      authModeService: { getAuthEnabled: async () => false } as any,
      jwtSecret: "test-secret",
    });
    const sender = await io.connect("malformed-sender");
    const payload = {
      drawingId: "drawing-1",
      elements: [
        {
          id: "element-1",
          type: "x".repeat(65),
          padding: "y".repeat(SOCKET_LIMITS.elementBytes),
        },
      ],
    };

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await sender.trigger("element-update", payload, vi.fn());
    }

    expect(sender.disconnected).toBe(true);
  });

  it("disconnects repeated well-formed oversized elements once they cross the hard-failure threshold", async () => {
    // This assertion is deliberately the inverse of what this suite checked
    // before: a "plausibly shaped but too large" element-update used to be an
    // ordinary refusal that could repeat forever without ever counting toward
    // a disconnect. That let a connection stream oversized-but-valid-looking
    // packets indefinitely. The rejection reason itself is unchanged -- see
    // the code/message assertion below -- only whether it now also counts.
    const io = new FakeIo();
    registerSocketHandlers({
      io: io as any,
      prisma: {
        drawing: { findUnique: vi.fn() },
        drawingLinkShare: { findFirst: vi.fn() },
      } as any,
      authModeService: { getAuthEnabled: async () => false } as any,
      jwtSecret: "test-secret",
    });
    const sender = await io.connect("oversized-sender");
    const payload = {
      drawingId: "drawing-1",
      elements: [
        {
          id: "element-1",
          type: "rectangle",
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          padding: "y".repeat(SOCKET_LIMITS.elementBytes),
        },
      ],
    };
    const answers: unknown[] = [];

    for (let attempt = 0; attempt < 12; attempt += 1) {
      await sender.trigger("element-update", payload, (answer: unknown) => answers.push(answer));
    }

    expect(answers).toHaveLength(12);
    expect(answers).toEqual(
      Array.from({ length: 12 }, () => ({
        ok: false,
        error: {
          code: "element-too-large",
          message: "element-update contains an oversized element",
        },
      })),
    );
    expect(sender.disconnected).toBe(true);
  });

  it("does not disconnect a client that only occasionally hits an oversized-element refusal", async () => {
    const io = new FakeIo();
    registerSocketHandlers({
      io: io as any,
      prisma: {
        drawing: { findUnique: vi.fn().mockResolvedValue({ userId: BOOTSTRAP_USER_ID }) },
        drawingLinkShare: { findFirst: vi.fn().mockResolvedValue(null) },
      } as any,
      authModeService: { getAuthEnabled: async () => false } as any,
      jwtSecret: "test-secret",
    });
    const sender = await io.connect("mostly-well-behaved-sender");
    await sender.trigger("join-room", { drawingId: "drawing-1", user: {} });
    const wellFormedElement = {
      id: "element-1",
      type: "rectangle",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    };
    const oversizedPayload = {
      drawingId: "drawing-1",
      elements: [{ ...wellFormedElement, padding: "y".repeat(SOCKET_LIMITS.elementBytes) }],
    };
    const ordinaryPayload = { drawingId: "drawing-1", elements: [wellFormedElement] };

    // Nine oversized rejections, one under the ten-per-minute disconnect
    // threshold, interleaved with ordinary updates that must keep succeeding.
    for (let attempt = 0; attempt < 9; attempt += 1) {
      await sender.trigger("element-update", oversizedPayload, vi.fn());
      const answers: unknown[] = [];
      await sender.trigger("element-update", ordinaryPayload, (answer: unknown) =>
        answers.push(answer),
      );
      expect(answers).toEqual([{ ok: true }]);
    }

    expect(sender.disconnected).toBe(false);
  });
});
