import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimeAdapter, AgentRuntimeConnection } from "./contracts";
import { AgentRuntimeRegistry } from "./registry";

const adapter: AgentRuntimeAdapter = {
  id: "stub",
  health: vi.fn(),
  start: vi.fn(),
  prompt: vi.fn(),
  status: vi.fn(),
  subscribe: vi.fn(),
};

const connection = (
  id: string,
  audience: AgentRuntimeConnection["audience"],
): AgentRuntimeConnection => ({
  id,
  label: id,
  adapterId: adapter.id,
  audience,
  profiles: [],
  policyCapabilities: [],
  adapterConfig: {},
});

describe("runtime connection audience", () => {
  it("supports installation and user connections without exposing another user's runtime", () => {
    const registry = new AgentRuntimeRegistry({
      adapters: [adapter],
      connections: [
        connection("shared", { kind: "installation" }),
        connection("alice-laptop", { kind: "user", userId: "alice" }),
        connection("bob-laptop", { kind: "user", userId: "bob" }),
      ],
    });

    expect(registry.listConnections("alice").map(({ id }) => id)).toEqual([
      "shared",
      "alice-laptop",
    ]);
    expect(registry.resolve("alice-laptop", "alice").connection.id).toBe("alice-laptop");
    expect(() => registry.resolve("bob-laptop", "alice")).toThrowError(
      expect.objectContaining({ code: "RUNTIME_NOT_CONFIGURED" }),
    );
  });
});
