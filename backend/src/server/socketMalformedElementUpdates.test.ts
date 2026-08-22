import { describe, expect, it, vi } from "vitest";
import { FakeIo } from "../__tests__/socketTestDoubles";
import { registerSocketHandlers } from "./socket";
import { SOCKET_LIMITS } from "./socketProtocol";

describe("malformed element-update traffic", () => {
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
});
