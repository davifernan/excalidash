import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { requestLogger } from "./requestLog";

const call = (path: string, headers: Record<string, string> = {}) => {
  const next = vi.fn();
  requestLogger(
    { path, method: "GET", ip: "127.0.0.1", headers } as never,
    {} as never,
    next as never,
  );
  return next;
};

const logged = () => (console.log as unknown as ReturnType<typeof vi.fn>).mock.calls;

describe("requestLogger", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the health probe out of the log", () => {
    const next = call("/health");

    expect(logged()).toHaveLength(0);
    expect(next).toHaveBeenCalled();
  });

  it("still logs an ordinary request, with its correlation key", () => {
    const next = call("/drawings", { "x-request-id": "abc-123" });

    expect(logged()).toHaveLength(1);
    expect(logged()[0][0]).toContain("[REQUEST] GET /drawings");
    expect(logged()[0][0]).toContain("RequestID: abc-123");
    expect(next).toHaveBeenCalled();
  });

  it("does not swallow a path that merely starts like the probe", () => {
    call("/healthcheck");
    call("/health/details");

    expect(logged()).toHaveLength(2);
  });

  it("keeps the separate line for a large request", () => {
    call("/import", { "content-length": String(20 * 1024 * 1024) });

    expect(logged()).toHaveLength(2);
    expect(logged()[0][0]).toContain("[LARGE REQUEST]");
  });
});
