import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntimeConnection } from "./contracts";
import { RuntimeDaemonBroker } from "./runtimeDaemonBroker";

const daemon = {
  id: "11111111-1111-4111-8111-111111111111",
  ownerUserId: "owner-1",
  label: "Owner laptop",
  daemonVersion: "0.16.0",
  profiles: [{ id: "codex", label: "Codex CLI" }],
  policyCapabilities: ["agent:read", "agent:run", "agent:prompt"] as const,
  costBearerLabel: "Owner",
  planLabel: null,
  limits: null,
  sessionEpoch: 1,
};

const active = (broker: RuntimeDaemonBroker): AgentRuntimeConnection => {
  broker.activate(daemon);
  const connection = broker.resolve(`daemon:${daemon.id}`, daemon.ownerUserId);
  if (!connection) throw new Error("test daemon did not activate");
  return connection;
};

describe("runtime daemon broker command lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("removes an expired undelivered command before a daemon polls", async () => {
    vi.useFakeTimers();
    const broker = new RuntimeDaemonBroker();
    const connection = active(broker);
    const dispatched = broker.dispatch(connection, "start", {
      assignmentId: "assignment-expired",
      profileId: "codex",
      displayName: "Expired",
      runId: "run-expired",
      drawingId: "drawing-1",
    });
    const rejected = expect(dispatched).rejects.toMatchObject({ code: "RUNTIME_NOT_CONNECTED" });

    await vi.advanceTimersByTimeAsync(15_001);
    await rejected;

    const delivery = broker.poll(daemon.id, daemon.sessionEpoch);
    await vi.advanceTimersByTimeAsync(25_001);
    await expect(delivery).resolves.toBeNull();
  });

  it("allows a valid cold start to acknowledge after the former 15-second deadline", async () => {
    vi.useFakeTimers();
    const broker = new RuntimeDaemonBroker();
    const connection = active(broker);
    const dispatched = broker.dispatch(connection, "start", {
      assignmentId: "assignment-cold-start",
      profileId: "codex",
      displayName: "Cold start",
      runId: "run-cold-start",
      drawingId: "drawing-1",
    });
    const command = await broker.poll(daemon.id, daemon.sessionEpoch);
    if (!command) throw new Error("test command was not delivered");

    await vi.advanceTimersByTimeAsync(30_001);
    broker.complete(daemon.id, daemon.sessionEpoch, command.commandId, {
      ok: true,
      runtimeHandle: "codex-thread-cold",
      status: "working",
    });

    await expect(dispatched).resolves.toMatchObject({ ok: true, status: "working" });
  });
});
