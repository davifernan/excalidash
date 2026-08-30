import { beforeEach, describe, expect, it, vi } from "vitest";

const post = vi.hoisted(() => vi.fn());
vi.mock("./client", () => ({ api: { post } }));

import { createPublicDispatch } from "./orchestratorThreads";

describe("orchestrator public dispatch API", () => {
  beforeEach(() => post.mockReset());

  it("publishes only the approved summary and an explicit public-effect gesture", async () => {
    post.mockResolvedValue({ data: { receipt: { id: "receipt-1" } } });
    await createPublicDispatch("drawing-1", "private-thread-1", {
      publicThreadId: "shared-thread-1",
      objectiveSummary: "Publish the approved comparison",
      targetContextIds: ["context-1"],
      connectionId: "runtime-1",
      profileId: "profile-1",
      displayName: "Board orchestrator",
    });

    expect(post).toHaveBeenCalledWith(
      "/drawings/drawing-1/orchestrator-threads/private-thread-1/dispatches",
      expect.objectContaining({
        objectiveSummary: "Publish the approved comparison",
        approval: { publicEffect: true },
        requestedCapabilities: expect.arrayContaining(["agent:run", "board:write"]),
      }),
    );
  });
});
