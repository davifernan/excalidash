import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

const RUNTIME_KEYS = [
  "AGENT_RUNTIME_HERDR_SOCKET_PATH",
  "AGENT_RUNTIME_HERDR_WORKING_DIRECTORY",
  "AGENT_RUNTIME_HERDR_PROFILES",
  "AGENT_FEATURES_ENABLED",
] as const;

const clearRuntime = () => {
  for (const key of RUNTIME_KEYS) delete process.env[key];
};

const configureRuntime = () => {
  process.env.AGENT_RUNTIME_HERDR_SOCKET_PATH = "/run/user/1000/herdr.sock";
  process.env.AGENT_RUNTIME_HERDR_WORKING_DIRECTORY = "/srv/agent-workspace";
  process.env.AGENT_RUNTIME_HERDR_PROFILES = JSON.stringify([
    { id: "codex", label: "Codex", agentKind: "codex", args: [] },
  ]);
};

const loadConfig = async () => {
  vi.resetModules();
  return import("./config");
};

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("feature config", () => {
  it("hides agent surfaces when no runtime is configured", async () => {
    clearRuntime();

    const { config } = await loadConfig();

    expect(config.features.agents).toBe(false);
  });

  it("shows agent surfaces once a runtime is configured", async () => {
    clearRuntime();
    configureRuntime();

    const { config } = await loadConfig();

    expect(config.features.agents).toBe(true);
  });

  it("lets an operator with a runtime keep the surfaces hidden", async () => {
    clearRuntime();
    configureRuntime();
    process.env.AGENT_FEATURES_ENABLED = "false";

    const { config } = await loadConfig();

    // The runtime stays configured -- only what the frontend offers changes.
    expect(config.agentRuntime.herdr).not.toBeNull();
    expect(config.features.agents).toBe(false);
  });

  it("lets an operator without a co-located runtime show the surfaces anyway", async () => {
    clearRuntime();
    process.env.AGENT_FEATURES_ENABLED = "true";

    const { config } = await loadConfig();

    expect(config.agentRuntime.herdr).toBeNull();
    expect(config.features.agents).toBe(true);
  });

  it("refuses a value it cannot read rather than guessing a direction", async () => {
    clearRuntime();
    process.env.AGENT_FEATURES_ENABLED = "maybe";

    // Guessing here would pick a default that is either a silent leak or a
    // silent outage; both look like the operator got what they asked for.
    await expect(loadConfig()).rejects.toThrow(/AGENT_FEATURES_ENABLED/);
  });
});
