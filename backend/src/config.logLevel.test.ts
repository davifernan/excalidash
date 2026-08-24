import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

const loadConfig = async () => {
  vi.resetModules();
  return import("./config");
};

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("LOG_LEVEL config", () => {
  it("defaults to info outside development", async () => {
    process.env.NODE_ENV = "production";
    process.env.JWT_SECRET = "x".repeat(32);
    delete process.env.LOG_LEVEL;

    const { config } = await loadConfig();

    expect(config.logLevel).toBe("info");
  });

  it("defaults to debug in development", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.LOG_LEVEL;

    const { config } = await loadConfig();

    expect(config.logLevel).toBe("debug");
  });

  it("an explicit LOG_LEVEL overrides the nodeEnv default", async () => {
    process.env.NODE_ENV = "development";
    process.env.LOG_LEVEL = "silent";

    const { config } = await loadConfig();

    expect(config.logLevel).toBe("silent");
  });

  it("is case-insensitive", async () => {
    process.env.NODE_ENV = "production";
    process.env.JWT_SECRET = "x".repeat(32);
    process.env.LOG_LEVEL = "DEBUG";

    const { config } = await loadConfig();

    expect(config.logLevel).toBe("debug");
  });

  it("rejects an unknown level", async () => {
    process.env.NODE_ENV = "production";
    process.env.JWT_SECRET = "x".repeat(32);
    process.env.LOG_LEVEL = "verbose";

    await expect(loadConfig()).rejects.toThrow("LOG_LEVEL must be one of: silent, info, debug");
  });
});
