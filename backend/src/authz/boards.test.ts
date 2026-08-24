import { describe, expect, it, vi } from "vitest";
import { transferOwnedBoards, transferOwnedCollections } from "./boards";

const buildDb = (overrides: Record<string, any> = {}) => ({
  drawing: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
  collection: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
  ...overrides,
});

describe("transferOwnedBoards", () => {
  it("does not filter by trash when excludeTrash is omitted (default; no production caller relies on this)", async () => {
    const db = buildDb();
    await transferOwnedBoards({ db: db as any, fromUserId: "member", toUserId: "admin" });
    expect(db.drawing.updateMany).toHaveBeenCalledWith({
      where: { userId: "member" },
      data: { userId: "admin", collectionId: null },
    });
  });

  it("excludes the account's own trash collection, without also excluding unorganized boards", async () => {
    const db = buildDb();
    await transferOwnedBoards({
      db: db as any,
      fromUserId: "member",
      toUserId: "admin",
      detachFromCollection: false,
      excludeTrash: true,
    });
    // A plain `{ collectionId: { not: "trash:member" } }` would also exclude
    // collectionId: null rows under SQL's three-valued `<>` logic -- the OR
    // with an explicit null clause is what keeps unorganized boards included.
    // (Verified empirically against sqlite; this test locks the shape in.)
    expect(db.drawing.updateMany).toHaveBeenCalledWith({
      where: {
        userId: "member",
        OR: [{ collectionId: null }, { collectionId: { not: "trash:member" } }],
      },
      data: { userId: "admin" },
    });
  });
});

describe("transferOwnedCollections", () => {
  it("excludes the account's own trash collection", async () => {
    const db = buildDb();
    await transferOwnedCollections({ db: db as any, fromUserId: "member", toUserId: "admin" });
    expect(db.collection.updateMany).toHaveBeenCalledWith({
      where: { userId: "member", id: { not: "trash:member" } },
      data: { userId: "admin" },
    });
  });
});
