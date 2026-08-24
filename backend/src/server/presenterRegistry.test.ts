import { describe, expect, it } from "vitest";
import { PresenterRegistry } from "./presenterRegistry";

describe("PresenterRegistry", () => {
  it("reports idle for a drawing nobody has ever presented", () => {
    const registry = new PresenterRegistry();
    expect(registry.snapshot("drawing-1")).toEqual({
      drawingId: "drawing-1",
      status: "idle",
      presenterPresenceId: null,
      presenterName: null,
      frameId: null,
      bounds: null,
      revision: 0,
    });
  });

  it("becomes presenting on start and reports the presenter", () => {
    const registry = new PresenterRegistry();
    const result = registry.start("drawing-1", "socket-a", "Ada");
    expect(result).toMatchObject({ status: "applied", changed: true });
    expect(registry.snapshot("drawing-1")).toMatchObject({
      status: "presenting",
      presenterPresenceId: "socket-a",
      presenterName: "Ada",
      revision: 1,
    });
    expect(registry.isPresenter("drawing-1", "socket-a")).toBe(true);
  });

  it("rejects a second presenter while one is already active", () => {
    const registry = new PresenterRegistry();
    registry.start("drawing-1", "socket-a", "Ada");
    const result = registry.start("drawing-1", "socket-b", "Bea");
    expect(result).toEqual({ status: "rejected", reason: "presenter-active" });
    expect(registry.isPresenter("drawing-1", "socket-b")).toBe(false);
  });

  it("treats a repeated start by the same presenter as a no-op, not a fresh revision", () => {
    const registry = new PresenterRegistry();
    registry.start("drawing-1", "socket-a", "Ada");
    const result = registry.start("drawing-1", "socket-a", "Ada");
    expect(result).toMatchObject({ status: "applied", changed: false });
    expect(registry.snapshot("drawing-1").revision).toBe(1);
  });

  it("advances the frame only for the current presenter", () => {
    const registry = new PresenterRegistry();
    registry.start("drawing-1", "socket-a", "Ada");
    const advanced = registry.advance("drawing-1", "socket-a", "frame-1", [0, 0, 100, 100]);
    expect(advanced).toMatchObject({ status: "applied", changed: true });
    expect(registry.snapshot("drawing-1")).toMatchObject({
      frameId: "frame-1",
      bounds: [0, 0, 100, 100],
      revision: 2,
    });

    const rejected = registry.advance("drawing-1", "socket-b", "frame-2", [0, 0, 1, 1]);
    expect(rejected).toEqual({ status: "rejected", reason: "not-presenting" });
    // A deposed/never-presenter's advance leaves the last real state untouched.
    expect(registry.snapshot("drawing-1").frameId).toBe("frame-1");
  });

  it("carries a freeform pan (frameId null) on the same channel as a named jump", () => {
    const registry = new PresenterRegistry();
    registry.start("drawing-1", "socket-a", "Ada");
    registry.advance("drawing-1", "socket-a", "frame-1", [0, 0, 10, 10]);
    const panned = registry.advance("drawing-1", "socket-a", null, [5, 5, 15, 15]);
    expect(panned).toMatchObject({ status: "applied" });
    expect(registry.snapshot("drawing-1")).toMatchObject({ frameId: null, bounds: [5, 5, 15, 15] });
  });

  it("lets the presenter stop themselves", () => {
    const registry = new PresenterRegistry();
    registry.start("drawing-1", "socket-a", "Ada");
    const result = registry.stop("drawing-1", "socket-a");
    expect(result).toMatchObject({ status: "applied", changed: true });
    expect(registry.snapshot("drawing-1").status).toBe("idle");
  });

  it("refuses a non-presenter's stop without force", () => {
    const registry = new PresenterRegistry();
    registry.start("drawing-1", "socket-a", "Ada");
    const result = registry.stop("drawing-1", "socket-b");
    expect(result).toEqual({ status: "rejected", reason: "not-presenting" });
    expect(registry.snapshot("drawing-1").presenterPresenceId).toBe("socket-a");
  });

  it("lets a forced stop end someone else's presentation (the owner takeover safety valve)", () => {
    const registry = new PresenterRegistry();
    registry.start("drawing-1", "socket-a", "Ada");
    const result = registry.stop("drawing-1", "socket-b", { force: true });
    expect(result).toMatchObject({ status: "applied", changed: true });
    expect(registry.snapshot("drawing-1").status).toBe("idle");
  });

  it("stopping an already-idle drawing is a no-op success, not a rejection", () => {
    const registry = new PresenterRegistry();
    const result = registry.stop("drawing-1", "socket-a");
    expect(result).toMatchObject({ status: "applied", changed: false });
  });

  it("forces a takeover by starting a new presenter over an active one", () => {
    const registry = new PresenterRegistry();
    registry.start("drawing-1", "socket-a", "Ada");
    const result = registry.start("drawing-1", "socket-b", "Bea", { force: true });
    expect(result).toMatchObject({ status: "applied", changed: true });
    expect(registry.snapshot("drawing-1")).toMatchObject({
      presenterPresenceId: "socket-b",
      presenterName: "Bea",
    });
    // The deposed presenter is not recognized as presenter anymore.
    expect(registry.isPresenter("drawing-1", "socket-a")).toBe(false);
  });

  it("clearSocket ends presenting when the leaving socket was the presenter", () => {
    const registry = new PresenterRegistry();
    registry.start("drawing-1", "socket-a", "Ada");
    const snapshot = registry.clearSocket("drawing-1", "socket-a");
    expect(snapshot).toMatchObject({ status: "idle" });
    expect(registry.snapshot("drawing-1").status).toBe("idle");
  });

  it("clearSocket is a silent no-op for a socket that was not presenting", () => {
    const registry = new PresenterRegistry();
    registry.start("drawing-1", "socket-a", "Ada");
    const snapshot = registry.clearSocket("drawing-1", "socket-b");
    expect(snapshot).toBeNull();
    expect(registry.snapshot("drawing-1").presenterPresenceId).toBe("socket-a");
  });

  it("keeps separate presenter state per drawing", () => {
    const registry = new PresenterRegistry();
    registry.start("drawing-1", "socket-a", "Ada");
    expect(registry.snapshot("drawing-2").status).toBe("idle");
    registry.start("drawing-2", "socket-b", "Bea");
    expect(registry.snapshot("drawing-1").presenterPresenceId).toBe("socket-a");
    expect(registry.snapshot("drawing-2").presenterPresenceId).toBe("socket-b");
  });

  it("clear removes all state for a drawing unconditionally", () => {
    const registry = new PresenterRegistry();
    registry.start("drawing-1", "socket-a", "Ada");
    registry.clear("drawing-1");
    expect(registry.snapshot("drawing-1")).toMatchObject({ status: "idle", revision: 0 });
  });
});
