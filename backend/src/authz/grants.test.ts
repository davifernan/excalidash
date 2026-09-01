import { describe, expect, it, vi } from "vitest";
import { getBoardsWithActiveLinkShare, grantDrawingAccessFromLink } from "./grants";

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

describe("grantDrawingAccessFromLink", () => {
  const dbWith = (existing: { id: string } | null) => {
    const create = vi.fn(async () => ({}));
    const findUnique = vi.fn(async () => existing);
    return { db: { drawingPermission: { findUnique, create } } as any, create, findUnique };
  };

  it("names a signed-in visitor at exactly the level the link grants", async () => {
    const { db, create } = dbWith(null);

    const result = await grantDrawingAccessFromLink({
      db,
      drawingId: "d1",
      userId: "u1",
      permission: "view",
    });

    expect(result).toBe("granted");
    expect(create).toHaveBeenCalledWith({
      data: {
        drawingId: "d1",
        granteeUserId: "u1",
        // Holding an account must not buy more than the URL was meant to
        // hand out.
        permission: "view",
        // Nobody invites themselves: a self-granted row IS the record of
        // "arrived through a link", which is what lets an owner tidying the
        // access list tell the two apart.
        createdByUserId: "u1",
      },
    });
  });

  it("leaves an existing membership alone rather than rewriting it", async () => {
    // Someone invited to edit must not lose that by opening a view link.
    const { db, create } = dbWith({ id: "existing" });

    const result = await grantDrawingAccessFromLink({
      db,
      drawingId: "d1",
      userId: "u1",
      permission: "view",
    });

    expect(result).toBe("already-a-member");
    expect(create).not.toHaveBeenCalled();
  });
});
