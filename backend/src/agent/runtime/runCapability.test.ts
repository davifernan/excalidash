import { describe, expect, it } from "vitest";
import { issueAgentRunCapability, verifyAgentRunCapability } from "./runCapability";

describe("ephemeral run capability", () => {
  const issued = () =>
    issueAgentRunCapability({
      secret: "test-secret",
      runId: "run-1",
      drawingId: "drawing-1",
      connectionId: "runtime-1",
      runtimeHandle: "opaque",
      subject: "user:u1",
      capabilities: ["agent:read", "agent:run"],
      now: new Date(1_000),
      ttlMs: 500,
    });

  it("binds drawing, subject and individual capability", () => {
    expect(issued().token).not.toContain("run-1");
    expect(issued().token).not.toContain("opaque");
    expect(
      verifyAgentRunCapability({
        secret: "test-secret",
        token: issued().token,
        drawingId: "drawing-1",
        subject: "user:u1",
        requiredCapability: "agent:read",
        now: new Date(1_100),
      }).runtimeHandle,
    ).toBe("opaque");
    expect(() =>
      verifyAgentRunCapability({
        secret: "test-secret",
        token: issued().token,
        drawingId: "drawing-1",
        subject: "user:u1",
        requiredCapability: "board:write",
        now: new Date(1_100),
      }),
    ).toThrowError(expect.objectContaining({ code: "RUN_CAPABILITY_FORBIDDEN" }));
  });

  it("rejects tampering and expiry without exposing token material", () => {
    expect(() =>
      verifyAgentRunCapability({
        secret: "test-secret",
        token: `${issued().token}x`,
        drawingId: "drawing-1",
        subject: "user:u1",
        requiredCapability: "agent:read",
      }),
    ).toThrowError(expect.objectContaining({ code: "RUN_CAPABILITY_INVALID" }));
    expect(() =>
      verifyAgentRunCapability({
        secret: "test-secret",
        token: issued().token,
        drawingId: "drawing-1",
        subject: "user:u1",
        requiredCapability: "agent:read",
        now: new Date(1_501),
      }),
    ).toThrowError(expect.objectContaining({ code: "RUN_CAPABILITY_EXPIRED" }));
  });
});
