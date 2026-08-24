import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "./config";
import { logger } from "./logger";

describe("logger", () => {
  const originalLogLevel = config.logLevel;
  let stdout: ReturnType<typeof vi.spyOn>;
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    config.logLevel = originalLogLevel;
  });

  const lastLine = (spy: ReturnType<typeof vi.spyOn>) => {
    const call = spy.mock.calls.at(-1);
    if (!call) throw new Error("Expected a write call.");
    return JSON.parse(call[0] as string);
  };

  it("writes a structured line with level, message and fields", () => {
    config.logLevel = "info";
    logger.info("drawing saved", { requestId: "abc-123", drawingId: "d1" });

    const line = lastLine(stdout);
    expect(line).toMatchObject({
      level: "info",
      message: "drawing saved",
      requestId: "abc-123",
      drawingId: "d1",
    });
    expect(typeof line.time).toBe("string");
  });

  it("always writes error, even at silent", () => {
    config.logLevel = "silent";
    logger.error("boom", { requestId: "abc-123" });

    expect(stderr).toHaveBeenCalledTimes(1);
    expect(lastLine(stderr)).toMatchObject({ level: "error", message: "boom" });
  });

  it("mutes info/warn/debug at silent", () => {
    config.logLevel = "silent";
    logger.info("x");
    logger.warn("y");
    logger.debug("z");

    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });

  it("keeps debug muted outside LOG_LEVEL=debug", () => {
    config.logLevel = "info";
    logger.debug("verbose");

    expect(stdout).not.toHaveBeenCalled();
  });

  it("writes debug only at LOG_LEVEL=debug", () => {
    config.logLevel = "debug";
    logger.debug("verbose");

    expect(lastLine(stdout)).toMatchObject({ level: "debug", message: "verbose" });
  });

  it("does not silently drop an Error field to {} via JSON.stringify", () => {
    config.logLevel = "info";
    logger.error("save failed", { error: new Error("disk full") });

    const line = lastLine(stderr);
    expect(line.error).toMatchObject({ name: "Error", message: "disk full" });
    expect(typeof line.error.stack).toBe("string");
  });

  it("writes warn at info level (only silent mutes it)", () => {
    config.logLevel = "info";
    logger.warn("careful");

    expect(lastLine(stderr)).toMatchObject({ level: "warn", message: "careful" });
  });
});
