import { EventEmitter } from "events";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { installProcessGuards } from "./processGuards";

describe("installProcessGuards", () => {
  let target: EventEmitter;
  let exit: ReturnType<typeof vi.fn>;

  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    target = new EventEmitter();
    exit = vi.fn();
    stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    installProcessGuards(target, exit);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const lastLine = () => JSON.parse(stderr.mock.calls[0][0] as string);

  it("prints an uncaught exception with its stack before ending the process", () => {
    const error = new Error("boom");

    target.emit("uncaughtException", error);

    const line = lastLine();
    expect(line).toMatchObject({ level: "error", message: "Uncaught exception, exiting" });
    expect(line.error).toMatchObject({ message: "boom", name: "Error" });
    expect(line.error.stack).toContain("boom");
  });

  it("prints an unhandled rejection with its stack before ending the process", () => {
    target.emit("unhandledRejection", new Error("rejected"));

    const line = lastLine();
    expect(line.reason).toMatchObject({ message: "rejected" });
  });

  it("still describes a rejection that is not an Error", () => {
    target.emit("unhandledRejection", "just a string");

    const line = lastLine();
    expect(line.reason).toBe("just a string");
  });

  it("ends the process for both, because listening replaces Node's own exit", () => {
    target.emit("uncaughtException", new Error("boom"));
    expect(exit).toHaveBeenCalledWith(1);

    exit.mockClear();
    target.emit("unhandledRejection", new Error("rejected"));
    expect(exit).toHaveBeenCalledWith(1);
  });
});
