import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { requestLogger } from "./requestLog";
import { config } from "../config";

const call = (path: string, headers: Record<string, string> = {}) => {
  const next = vi.fn();
  requestLogger(
    { path, method: "GET", ip: "127.0.0.1", headers } as never,
    {} as never,
    next as never,
  );
  return next;
};

const logged = () =>
  (process.stdout.write as unknown as ReturnType<typeof vi.fn>).mock.calls.map((call) =>
    JSON.parse(call[0] as string),
  );

describe("requestLogger", () => {
  const originalLogLevel = config.logLevel;

  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    config.logLevel = originalLogLevel;
  });

  it("keeps the health probe out of the log", () => {
    config.logLevel = "debug";
    const next = call("/health");

    expect(logged()).toHaveLength(0);
    expect(next).toHaveBeenCalled();
  });

  it("does not swallow a path that merely starts like the probe", () => {
    config.logLevel = "debug";
    call("/healthcheck");
    call("/health/details");

    expect(logged()).toHaveLength(2);
  });

  it("at the production default (info), stays silent for an ordinary request", () => {
    config.logLevel = "info";
    const next = call("/drawings", { "x-request-id": "abc-123" });

    expect(logged()).toHaveLength(0);
    expect(next).toHaveBeenCalled();
  });

  it("at the production default (info), still keeps the line for a large request", () => {
    config.logLevel = "info";
    call("/import", { "content-length": String(20 * 1024 * 1024) });

    expect(logged()).toHaveLength(1);
    expect(logged()[0]).toMatchObject({ level: "info", message: "large request" });
  });

  it("at debug, logs an ordinary request with its correlation key", () => {
    config.logLevel = "debug";
    const next = call("/drawings", { "x-request-id": "abc-123" });

    expect(logged()).toHaveLength(1);
    expect(logged()[0]).toMatchObject({
      level: "debug",
      message: "request",
      path: "/drawings",
      requestId: "abc-123",
    });
    expect(next).toHaveBeenCalled();
  });

  it("at debug, keeps both the request line and the large-request line", () => {
    config.logLevel = "debug";
    call("/import", { "content-length": String(20 * 1024 * 1024) });

    expect(logged()).toHaveLength(2);
    expect(logged()[0]).toMatchObject({ level: "info", message: "large request" });
    expect(logged()[1]).toMatchObject({ level: "debug", message: "request" });
  });

  it("at silent, drops even the large-request line", () => {
    config.logLevel = "silent";
    call("/import", { "content-length": String(20 * 1024 * 1024) });

    expect(logged()).toHaveLength(0);
  });
});
