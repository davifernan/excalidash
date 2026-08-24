import { describe, expect, it, vi } from "vitest";
import { getBoardsWithActiveLinkShare } from "./grants";

describe("getBoardsWithActiveLinkShare", () => {
  it("returns an empty set without querying when there are no ids to check", async () => {
    const findMany = vi.fn();
    const db: any = { drawingLinkShare: { findMany } };

    const result = await getBoardsWithActiveLinkShare({ db, drawingIds: [] });

    expect(result).toEqual(new Set());
    expect(findMany).not.toHaveBeenCalled();
  });

  it("only counts a link that is neither revoked nor expired", async () => {
    const now = new Date("2026-08-24T12:00:00Z");
    const findMany = vi.fn(async ({ where }: any) => {
      expect(where).toEqual({
        drawingId: { in: ["d1", "d2"] },
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      });
      return [{ drawingId: "d1" }];
    });
    const db: any = { drawingLinkShare: { findMany } };

    const result = await getBoardsWithActiveLinkShare({ db, drawingIds: ["d1", "d2"], now });

    expect(result).toEqual(new Set(["d1"]));
  });
});
