import { describe, expect, it, vi } from "vitest";
import type {
  AgentRuntimeAdapter,
  AgentRuntimeConnection,
  RuntimeStartInput,
  RuntimeStatusEvent,
} from "./contracts";
import { AgentRuntimeGateway } from "./gateway";
import { AgentRuntimeRegistry } from "./registry";

class StubAdapter implements AgentRuntimeAdapter {
  constructor(readonly id: string) {}
  health = vi.fn(async () => ({ connected: true, status: "connected" as const }));
  start = vi.fn(async (_connection: AgentRuntimeConnection, input: RuntimeStartInput) => ({
    handle: `${this.id}-handle`,
    status: "working" as const,
    displayName: input.displayName,
  }));
  prompt = vi.fn(async (): Promise<RuntimeStatusEvent> => ({ status: "working" }));
  status = vi.fn(async (): Promise<RuntimeStatusEvent> => ({ status: "idle" }));
  subscribe = vi.fn(async () => ({ close: vi.fn(), closed: new Promise<void>(() => undefined) }));
}

const connection = (adapterId: string): AgentRuntimeConnection => ({
  id: `connection-${adapterId}`,
  label: adapterId,
  adapterId,
  audience: { kind: "installation" },
  profiles: [{ id: "default", label: "Default" }],
  policyCapabilities: ["agent:read", "agent:run", "agent:prompt"],
  costBearer: { ownerKind: "operator", ownerId: "test-operator", label: "Test operator" },
  adapterConfig: {},
});

const startWith = (adapter: AgentRuntimeAdapter) => {
  const runtimeConnection = connection(adapter.id);
  const gateway = new AgentRuntimeGateway(
    new AgentRuntimeRegistry({ adapters: [adapter], connections: [runtimeConnection] }),
    "secret",
  );
  return gateway.start({
    drawingId: "drawing-1",
    access: "edit",
    principal: { kind: "user", userId: "user-1" },
    connectionId: runtimeConnection.id,
    profileId: "default",
    displayName: "Research",
    approvedCapabilities: ["agent:read", "agent:run", "agent:prompt"],
  });
};

describe("runtime-neutral gateway seam", () => {
  it("projects only the immutable cost label and never the server audit owner", async () => {
    const adapter = new StubAdapter("cost");
    const runtimeConnection = connection(adapter.id);
    const gateway = new AgentRuntimeGateway(
      new AgentRuntimeRegistry({ adapters: [adapter], connections: [runtimeConnection] }),
      "secret",
    );
    await expect(gateway.connections("user-1")).resolves.toEqual([
      expect.objectContaining({ costBearer: { label: "Test operator" } }),
    ]);
    expect(JSON.stringify(await gateway.connections("user-1"))).not.toContain("test-operator");
  });

  it("runs the identical caller against two independent adapter implementations", async () => {
    const first = new StubAdapter("first");
    const second = new StubAdapter("second");
    const firstResult = await startWith(first);
    const secondResult = await startWith(second);
    expect(firstResult.run.status).toBe("working");
    expect(secondResult.run.status).toBe("working");
    expect(first.start).toHaveBeenCalledOnce();
    expect(second.start).toHaveBeenCalledOnce();
  });

  it("carries a stable assignment identity separately from the run identity", async () => {
    const adapter = new StubAdapter("assignment");
    const runtimeConnection = connection(adapter.id);
    const gateway = new AgentRuntimeGateway(
      new AgentRuntimeRegistry({ adapters: [adapter], connections: [runtimeConnection] }),
      "secret",
    );

    await gateway.start({
      drawingId: "drawing-1",
      access: "edit",
      principal: { kind: "user", userId: "user-1" },
      connectionId: runtimeConnection.id,
      profileId: "default",
      displayName: "Research",
      approvedCapabilities: ["agent:read", "agent:run"],
      assignmentId: "assignment-stable",
      runId: "run-stable",
    });

    expect(adapter.start).toHaveBeenCalledWith(
      runtimeConnection,
      expect.objectContaining({ assignmentId: "assignment-stable", runId: "run-stable" }),
    );
  });

  it("rejects start before invoking the adapter when board rights do not grant it", async () => {
    const adapter = new StubAdapter("blocked");
    const runtimeConnection = connection(adapter.id);
    const gateway = new AgentRuntimeGateway(
      new AgentRuntimeRegistry({ adapters: [adapter], connections: [runtimeConnection] }),
      "secret",
    );
    await expect(
      gateway.start({
        drawingId: "drawing-1",
        access: "view",
        principal: { kind: "user", userId: "viewer" },
        connectionId: runtimeConnection.id,
        profileId: "default",
        displayName: "Forbidden",
        approvedCapabilities: ["agent:run"],
      }),
    ).rejects.toMatchObject({ code: "RUN_CAPABILITY_FORBIDDEN" });
    expect(adapter.start).not.toHaveBeenCalled();
  });

  it("revalidates current human rights before a later prompt", async () => {
    const adapter = new StubAdapter("revoked");
    const runtimeConnection = connection(adapter.id);
    const gateway = new AgentRuntimeGateway(
      new AgentRuntimeRegistry({ adapters: [adapter], connections: [runtimeConnection] }),
      "secret",
    );
    const started = await gateway.start({
      drawingId: "drawing-1",
      access: "edit",
      principal: { kind: "user", userId: "user-1" },
      connectionId: runtimeConnection.id,
      profileId: "default",
      displayName: "Research",
      approvedCapabilities: ["agent:read", "agent:run", "agent:prompt"],
    });
    await expect(
      gateway.prompt({
        drawingId: "drawing-1",
        access: "view",
        principal: { kind: "user", userId: "user-1" },
        runCapability: started.runCapability,
        text: "continue",
      }),
    ).rejects.toMatchObject({ code: "RUN_CAPABILITY_FORBIDDEN" });
    expect(adapter.prompt).not.toHaveBeenCalled();
  });

  it("revalidates the connection runtime policy before a later prompt", async () => {
    const adapter = new StubAdapter("policy-revoked");
    const runtimeConnection = connection(adapter.id);
    const policyCapabilities = [...runtimeConnection.policyCapabilities];
    runtimeConnection.policyCapabilities = policyCapabilities;
    const gateway = new AgentRuntimeGateway(
      new AgentRuntimeRegistry({ adapters: [adapter], connections: [runtimeConnection] }),
      "secret",
    );
    const started = await gateway.start({
      drawingId: "drawing-1",
      access: "edit",
      principal: { kind: "user", userId: "user-1" },
      connectionId: runtimeConnection.id,
      profileId: "default",
      displayName: "Research",
      approvedCapabilities: ["agent:read", "agent:run", "agent:prompt"],
    });

    policyCapabilities.splice(policyCapabilities.indexOf("agent:prompt"), 1);

    await expect(
      gateway.prompt({
        drawingId: "drawing-1",
        access: "edit",
        principal: { kind: "user", userId: "user-1" },
        runCapability: started.runCapability,
        text: "continue",
      }),
    ).rejects.toMatchObject({ code: "RUN_CAPABILITY_FORBIDDEN" });
    expect(adapter.prompt).not.toHaveBeenCalled();
  });
});
