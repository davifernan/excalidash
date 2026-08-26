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

  it("keeps a revisioned live draft only while its owning lock exists", () => {
    const locks = new DocumentEditLockRegistry();
    const acquired = locks.acquire({
      drawingId: "board",
      assetId: "markdown",
      presenceId: "browser-a",
      ownerName: "Alice",
    });
    if (!acquired.ok) throw new Error("lock missing");

    expect(
      locks.applyDraftPatch({
        drawingId: "board",
        assetId: "markdown",
        presenceId: "browser-a",
        token: acquired.lock.token,
        revision: 1,
        start: 0,
        deleteCount: 0,
        text: "# Original",
        maxBytes: 1_000,
      }),
    ).toMatchObject({ revision: 1, content: "# Original" });
    expect(
      locks.applyDraftPatch({
        drawingId: "board",
        assetId: "markdown",
        presenceId: "browser-a",
        token: acquired.lock.token,
        revision: 2,
        start: 2,
        deleteCount: 8,
        text: "Live",
        maxBytes: 1_000,
      }),
    ).toMatchObject({ revision: 2, content: "# Live" });
    expect(locks.draftSnapshot("board")).toEqual([
      {
        assetId: "markdown",
        presenceId: "browser-a",
        revision: 2,
        content: "# Live",
      },
    ]);

    expect(locks.releaseToken("board", "markdown", acquired.lock.token)).not.toBeNull();
    expect(locks.draftSnapshot("board")).toEqual([]);
  });

  it("rejects another browser, skipped revisions, invalid spans, and oversized results", () => {
    const locks = new DocumentEditLockRegistry();
    const acquired = locks.acquire({
      drawingId: "board",
      assetId: "markdown",
      presenceId: "browser-a",
      ownerName: "Alice",
    });
    if (!acquired.ok) throw new Error("lock missing");
    const patch = {
      drawingId: "board",
      assetId: "markdown",
      token: acquired.lock.token,
      revision: 1,
      start: 0,
      deleteCount: 0,
      text: "draft",
      maxBytes: 100,
    };

    expect(locks.applyDraftPatch({ ...patch, presenceId: "browser-b" })).toBeNull();
    expect(locks.applyDraftPatch({ ...patch, presenceId: "browser-a", revision: 2 })).toBeNull();
    expect(locks.applyDraftPatch({ ...patch, presenceId: "browser-a", start: 1 })).toBeNull();
    expect(
      locks.applyDraftPatch({ ...patch, presenceId: "browser-a", text: "too large", maxBytes: 2 }),
    ).toBeNull();
    expect(locks.draftSnapshot("board")).toEqual([]);
  });
});
