import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimeConnection } from "./contracts";
import { HerdrAgentRuntimeAdapter } from "./herdrAdapter";
import type { HerdrTransport } from "./herdrTransport";

const connection: AgentRuntimeConnection = {
  id: "runtime",
  label: "Runtime",
  adapterId: "herdr",
  audience: { kind: "installation" },
  profiles: [{ id: "review", label: "Review" }],
  policyCapabilities: ["agent:read", "agent:run", "agent:prompt"],
  costBearer: { ownerKind: "operator", ownerId: "test-operator", label: "Test operator" },
  adapterConfig: {
    socketPath: "/private/herdr.sock",
    workingDirectory: "/workspace",
    profiles: [{ id: "review", label: "Review", agentKind: "codex", args: ["--safe"] }],
  },
};

describe("Herdr runtime adapter", () => {
  it("contains all Herdr terms behind the generic start contract", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        type: "workspace_created",
        workspace: { workspace_id: "w1" },
        root_pane: { pane_id: "w1:p1" },
      })
      .mockResolvedValueOnce({
        type: "agent_started",
        agent: { name: "Research", agent_status: "working" },
      })
      .mockResolvedValueOnce({
        type: "agent_prompted",
        agent: { name: "Research", agent_status: "working" },
      });
    const transport: HerdrTransport = {
      request,
      subscribe: vi.fn(),
    };
    const adapter = new HerdrAgentRuntimeAdapter(transport);
    const result = await adapter.start(connection, {
      profileId: "review",
      displayName: "Research",
      initialPrompt: "Inspect the board context",
      runId: "run-1",
      drawingId: "drawing-1",
    });
    expect(result).toMatchObject({ status: "working", displayName: "Research" });
    expect(request.mock.calls.map((call) => call[1])).toEqual([
      "workspace.create",
      "agent.start",
      "agent.prompt",
    ]);
    expect(request.mock.calls[0][2]).toMatchObject({
      focus: false,
      env: { EXCALIDASH_RUN_ID: "run-1", EXCALIDASH_DRAWING_ID: "drawing-1" },
    });
  });

  it("reports a stopped runtime as disconnected without leaking its socket path", async () => {
    const transport: HerdrTransport = {
      request: vi.fn().mockRejectedValue(new Error("connect /private/herdr.sock token=secret")),
      subscribe: vi.fn(),
    };
    await expect(new HerdrAgentRuntimeAdapter(transport).health(connection)).resolves.toEqual({
      connected: false,
      status: "disconnected",
    });
  });

  it("hands the stable DispatchReceipt and immutable Board mount to the foreign runtime", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        type: "workspace_created",
        workspace: { workspace_id: "w1" },
        root_pane: { pane_id: "w1:p1" },
      })
      .mockResolvedValueOnce({
        type: "agent_started",
        agent: { name: "Research", agent_status: "working" },
      });
    const adapter = new HerdrAgentRuntimeAdapter({ request, subscribe: vi.fn() });
    await adapter.start(connection, {
      profileId: "review",
      displayName: "Research",
      runId: "run-public",
      drawingId: "drawing-1",
      dispatchId: "dispatch-1",
      boardMount: {
        revisionId: "revision-7",
        capabilityToken: "exd_mount_secret",
        allowedContextIds: ["context-b", "context-a"],
      },
    });
    expect(request.mock.calls[0][2].env).toEqual({
      EXCALIDASH_RUN_ID: "run-public",
      EXCALIDASH_DRAWING_ID: "drawing-1",
      EXCALIDASH_DISPATCH_ID: "dispatch-1",
      EXCALIDASH_REVISION_ID: "revision-7",
      EXCALIDASH_MOUNT_TOKEN: "exd_mount_secret",
      EXCALIDASH_ALLOWED_CONTEXT_IDS: JSON.stringify(["context-b", "context-a"]),
    });
  });
});
