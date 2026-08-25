import { describe, expect, it } from "vitest";
import { DocumentEditLockRegistry } from "./documentEditLocks";

describe("DocumentEditLockRegistry", () => {
  it("gives one browser the file and refuses a second until the owner releases it", () => {
    const locks = new DocumentEditLockRegistry();
    const first = locks.acquire({
      drawingId: "board",
      assetId: "markdown",
      presenceId: "browser-a",
      ownerName: "Alice",
    });
    expect(first.ok).toBe(true);
    const second = locks.acquire({
      drawingId: "board",
      assetId: "markdown",
      presenceId: "browser-b",
      ownerName: "Bob",
    });
    expect(second).toEqual(
      expect.objectContaining({ ok: false, lock: expect.objectContaining({ ownerName: "Alice" }) }),
    );

    if (!first.ok) throw new Error("first lock missing");
    expect(locks.release("board", "markdown", "browser-a", first.lock.token)).toBe(true);
    expect(
      locks.acquire({
        drawingId: "board",
        assetId: "markdown",
        presenceId: "browser-b",
        ownerName: "Bob",
      }).ok,
    ).toBe(true);
  });

  it("drops every lock owned by a disconnected browser without exposing tokens", () => {
    const locks = new DocumentEditLockRegistry();
    locks.acquire({
      drawingId: "board-a",
      assetId: "one",
      presenceId: "browser-a",
      ownerName: "Alice",
    });
    locks.acquire({
      drawingId: "board-b",
      assetId: "two",
      presenceId: "browser-a",
      ownerName: "Alice",
    });

    expect(locks.snapshot("board-a")).toEqual([
      { assetId: "one", presenceId: "browser-a", ownerName: "Alice" },
    ]);
    expect(locks.releasePresence("browser-a").sort()).toEqual(["board-a", "board-b"]);
    expect(locks.snapshot("board-a")).toEqual([]);
  });
});
