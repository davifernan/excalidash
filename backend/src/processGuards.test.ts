import { EventEmitter } from "events";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { installProcessGuards } from "./processGuards";

describe("installProcessGuards", () => {
  let target: EventEmitter;
  let exit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    target = new EventEmitter();
    exit = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => {});
    installProcessGuards(target, exit);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints an uncaught exception with its stack before ending the process", () => {
    const error = new Error("boom");

    target.emit("uncaughtException", error);

    const [, payload] = (console.error as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(payload).toMatchObject({ message: "boom", name: "Error" });
    expect((payload as { stack?: string }).stack).toContain("boom");
  });

  it("prints an unhandled rejection with its stack before ending the process", () => {
    target.emit("unhandledRejection", new Error("rejected"));

    const [, payload] = (console.error as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(payload).toMatchObject({ message: "rejected" });
  });

  it("still describes a rejection that is not an Error", () => {
    target.emit("unhandledRejection", "just a string");

    const [, payload] = (console.error as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(payload).toBe("just a string");
  });

  it("ends the process for both, because listening replaces Node's own exit", () => {
    target.emit("uncaughtException", new Error("boom"));
    expect(exit).toHaveBeenCalledWith(1);

    exit.mockClear();
    target.emit("unhandledRejection", new Error("rejected"));
    expect(exit).toHaveBeenCalledWith(1);
  });
});
