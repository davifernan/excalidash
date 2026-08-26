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

  describe("NIL-619: redaction before the line is written durably", () => {
    it("redacts a field literally named token/secret/password/authorization/cookie/apikey/jwt", () => {
      config.logLevel = "info";
      logger.info("auth event", {
        token: "abc.def.ghi",
        secret: "s3cr3t",
        password: "hunter2",
        authorization: "Bearer abc",
        cookie: "session=xyz",
        apiKey: "key-123",
        jwt: "abc.def.ghi",
        drawingId: "d1",
      });

      const line = lastLine(stdout);
      expect(line.token).toBe("[redacted]");
      expect(line.secret).toBe("[redacted]");
      expect(line.password).toBe("[redacted]");
      expect(line.authorization).toBe("[redacted]");
      expect(line.cookie).toBe("[redacted]");
      expect(line.apiKey).toBe("[redacted]");
      expect(line.jwt).toBe("[redacted]");
      // A field with no name collision keeps its real value.
      expect(line.drawingId).toBe("d1");
    });

    it("redacts email and userEmail -- an address is a durably-retained record, not a rotating one", () => {
      config.logLevel = "info";
      logger.info("invitation failed", {
        email: "davi@example.com",
        userEmail: "guest@example.com",
      });

      const line = lastLine(stdout);
      expect(line.email).toBe("[redacted]");
      expect(line.userEmail).toBe("[redacted]");
    });

    it("redacts a nested/compound key name (resetToken, refreshTokenId) the same way", () => {
      config.logLevel = "info";
      logger.info("token issued", { resetToken: "abc", refreshTokenId: "id-1" });

      const line = lastLine(stdout);
      expect(line.resetToken).toBe("[redacted]");
      expect(line.refreshTokenId).toBe("[redacted]");
    });

    it("does not redact an unrelated field, and leaves fields with no match untouched entirely", () => {
      config.logLevel = "info";
      logger.info("drawing saved", { drawingId: "d1", elementCount: 3 });

      const line = lastLine(stdout);
      expect(line.drawingId).toBe("d1");
      expect(line.elementCount).toBe(3);
    });

    it("still redacts at error level, where reportBackendError also runs", () => {
      config.logLevel = "info";
      logger.error("invitation failed", { email: "davi@example.com" });

      expect(lastLine(stderr).email).toBe("[redacted]");
    });
  });
});
