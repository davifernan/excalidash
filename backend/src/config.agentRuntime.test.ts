import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };
const RUNTIME_KEYS = [
  "AGENT_RUNTIME_HERDR_SOCKET_PATH",
  "AGENT_RUNTIME_HERDR_WORKING_DIRECTORY",
  "AGENT_RUNTIME_HERDR_PROFILES",
  "AGENT_RUNTIME_OPERATOR_ID",
  "AGENT_RUNTIME_OPERATOR_LABEL",
] as const;

const loadConfig = async () => {
  vi.resetModules();
  return import("./config");
};

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("Agent Runtime config", () => {
  it("leaves the runtime disconnected when no topology is configured", async () => {
    for (const key of RUNTIME_KEYS) delete process.env[key];

    const { config } = await loadConfig();

    expect(config.agentRuntime).toEqual({ herdr: null });
  });

  it("accepts an allowlisted co-located Herdr connection", async () => {
    process.env.AGENT_RUNTIME_HERDR_SOCKET_PATH = "/run/user/1000/herdr.sock";
    process.env.AGENT_RUNTIME_HERDR_WORKING_DIRECTORY = "/srv/agent-workspace";
    process.env.AGENT_RUNTIME_HERDR_PROFILES = JSON.stringify([
      { id: "codex", label: "Codex", agentKind: "codex", args: ["--model", "default"] },
    ]);

    const { config } = await loadConfig();

    expect(config.agentRuntime.herdr).toEqual({
      socketPath: "/run/user/1000/herdr.sock",
      workingDirectory: "/srv/agent-workspace",
      profiles: [{ id: "codex", label: "Codex", agentKind: "codex", args: ["--model", "default"] }],
      operatorId: "installation",
      operatorLabel: "Instance operator",
    });
  });

  it("keeps a configured operator audit id separate from its safe display label", async () => {
    process.env.AGENT_RUNTIME_HERDR_SOCKET_PATH = "/run/user/1000/herdr.sock";
    process.env.AGENT_RUNTIME_HERDR_WORKING_DIRECTORY = "/srv/agent-workspace";
    process.env.AGENT_RUNTIME_HERDR_PROFILES = JSON.stringify([
      { id: "codex", label: "Codex", agentKind: "codex", args: [] },
    ]);
    process.env.AGENT_RUNTIME_OPERATOR_ID = "internal-billing-record-17";
    process.env.AGENT_RUNTIME_OPERATOR_LABEL = "Research Operations";

    const { config } = await loadConfig();

    expect(config.agentRuntime.herdr).toMatchObject({
      operatorId: "internal-billing-record-17",
      operatorLabel: "Research Operations",
    });
  });

  it("rejects a partial runtime topology", async () => {
    delete process.env.AGENT_RUNTIME_HERDR_SOCKET_PATH;
    process.env.AGENT_RUNTIME_HERDR_WORKING_DIRECTORY = "/srv/agent-workspace";
    process.env.AGENT_RUNTIME_HERDR_PROFILES = "[]";

    await expect(loadConfig()).rejects.toThrow("must be configured together");
  });

  it("rejects relative local socket and workspace paths", async () => {
    process.env.AGENT_RUNTIME_HERDR_SOCKET_PATH = "runtime/herdr.sock";
    process.env.AGENT_RUNTIME_HERDR_WORKING_DIRECTORY = "/srv/agent-workspace";
    process.env.AGENT_RUNTIME_HERDR_PROFILES = JSON.stringify([
      { id: "codex", label: "Codex", agentKind: "codex", args: [] },
    ]);

    await expect(loadConfig()).rejects.toThrow("must be absolute paths");
  });

  it("rejects duplicate profile identifiers", async () => {
    process.env.AGENT_RUNTIME_HERDR_SOCKET_PATH = "/run/user/1000/herdr.sock";
    process.env.AGENT_RUNTIME_HERDR_WORKING_DIRECTORY = "/srv/agent-workspace";
    process.env.AGENT_RUNTIME_HERDR_PROFILES = JSON.stringify([
      { id: "same", label: "One", agentKind: "codex", args: [] },
      { id: "same", label: "Two", agentKind: "claude", args: [] },
    ]);

    await expect(loadConfig()).rejects.toThrow("ids must be unique");
  });
});
