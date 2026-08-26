import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "./logging";

const notification = vi.hoisted(() => vi.fn());
vi.mock("./notifications", () => ({ notify: notification }));

describe("log", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    notification.mockClear();
  });

  const lastLine = (spy: ReturnType<typeof vi.spyOn>) => {
    const call = spy.mock.calls.at(-1);
    if (!call) throw new Error("Expected a console call.");
    return JSON.parse(call[0] as string);
  };

  it("writes a structured line with level, message and fields", () => {
    log.info("drawing saved", { drawingId: "d1" });

    const line = lastLine(infoSpy);
    expect(line).toMatchObject({ level: "info", message: "drawing saved", drawingId: "d1" });
    expect(typeof line.time).toBe("string");
  });

  it("error() always writes to console.error", () => {
    log.error("boom", { drawingId: "d1" });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(lastLine(errorSpy)).toMatchObject({ level: "error", message: "boom", drawingId: "d1" });
  });

  it("error() includes a reference id in the console line and returns it", () => {
    const ref = log.error("boom");

    expect(lastLine(errorSpy).ref).toBe(ref);
    expect(ref).toMatch(/^[0-9a-f]{8}$/i);
  });

  it("error() notifies with the reference id by default", () => {
    const ref = log.error("Could not load drawings");

    expect(notification).toHaveBeenCalledTimes(1);
    expect(notification).toHaveBeenCalledWith(
      "error",
      "Could not load drawings",
      expect.objectContaining({ detail: `Reference ${ref}` }),
    );
  });

  it("error() does not toast when notify is false", () => {
    log.error("boom", undefined, { notify: false });

    expect(notification).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("warn() is console-only, never toasts", () => {
    log.warn("careful", { drawingId: "d1" });

    expect(lastLine(warnSpy)).toMatchObject({ level: "warn", message: "careful" });
    expect(notification).not.toHaveBeenCalled();
  });

  it("does not silently drop an Error field to {} via JSON.stringify", () => {
    log.error("save failed", { error: new Error("disk full") });

    const line = lastLine(errorSpy);
    expect(line.error).toMatchObject({ name: "Error", message: "disk full" });
    expect(typeof line.error.stack).toBe("string");
  });

  it("debug() writes in dev (this suite runs under Vite's DEV mode)", () => {
    log.debug("verbose");

    expect(lastLine(debugSpy)).toMatchObject({ level: "debug", message: "verbose" });
  });
});
