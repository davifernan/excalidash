import { beforeEach, describe, expect, it, vi } from "vitest";

const post = vi.hoisted(() => vi.fn());

vi.mock("./client", () => ({ API_URL: "/api", api: { post } }));
vi.mock("./auth", () => ({ currentCsrfHeader: () => ({}) }));

import { startAgentRuntimeRun } from "./agentRuntime";

describe("agent runtime board-gateway projection", () => {
  beforeEach(() => post.mockReset());

  it("accepts and brands a defined board run state at the HTTP boundary", async () => {
    post.mockResolvedValue({
      data: {
        run: { id: "run-1", displayName: "Research", status: "working", capabilities: [] },
        runCapability: "opaque",
        expiresAt: "2026-08-29T12:00:00.000Z",
      },
    });

    await expect(
      startAgentRuntimeRun("drawing-1", {
        connectionId: "local",
        profileId: "default",
        displayName: "Research",
      }),
    ).resolves.toMatchObject({ run: { status: "working" } });
  });

  it("rejects a provider-specific or unknown state at the HTTP boundary", async () => {
    post.mockResolvedValue({
      data: {
        run: { id: "run-1", displayName: "Research", status: "herdr-paused", capabilities: [] },
        runCapability: "opaque",
        expiresAt: "2026-08-29T12:00:00.000Z",
      },
    });

    await expect(
      startAgentRuntimeRun("drawing-1", {
        connectionId: "local",
        profileId: "default",
        displayName: "Research",
      }),
    ).rejects.toThrow("invalid run state");
  });
});
