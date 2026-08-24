import { describe, expect, it, vi } from "vitest";
import { getFavoriteDrawingIds, setDrawingFavorite } from "./favorites";

describe("setDrawingFavorite", () => {
  it("upserts to add a favorite", async () => {
    const upsert = vi.fn().mockResolvedValue({});
    const prisma: any = { drawingFavorite: { upsert } };

    await setDrawingFavorite({ prisma, userId: "u1", drawingId: "d1", favorite: true });

    expect(upsert).toHaveBeenCalledWith({
      where: { userId_drawingId: { userId: "u1", drawingId: "d1" } },
      create: { userId: "u1", drawingId: "d1" },
      update: {},
    });
  });

  it("deletes to remove a favorite", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma: any = { drawingFavorite: { deleteMany } };

    await setDrawingFavorite({ prisma, userId: "u1", drawingId: "d1", favorite: false });

    expect(deleteMany).toHaveBeenCalledWith({ where: { userId: "u1", drawingId: "d1" } });
  });
});

describe("getFavoriteDrawingIds", () => {
  it("returns an empty set without querying when there are no ids to check", async () => {
    const findMany = vi.fn();
    const prisma: any = { drawingFavorite: { findMany } };

    const result = await getFavoriteDrawingIds({ prisma, userId: "u1", drawingIds: [] });

    expect(result).toEqual(new Set());
    expect(findMany).not.toHaveBeenCalled();
  });

  it("returns only the ids favorited by this user", async () => {
    const findMany = vi.fn().mockResolvedValue([{ drawingId: "d1" }]);
    const prisma: any = { drawingFavorite: { findMany } };

    const result = await getFavoriteDrawingIds({
      prisma,
      userId: "u1",
      drawingIds: ["d1", "d2"],
    });

    expect(findMany).toHaveBeenCalledWith({
      where: { userId: "u1", drawingId: { in: ["d1", "d2"] } },
      select: { drawingId: true },
    });
    expect(result).toEqual(new Set(["d1"]));
  });
});
