import { describe, expect, it, vi } from "vitest";
import { COMPANY_ARCHIVE_USER_EMAIL, offboardUserAndTransferBoards } from "./userOffboarding";

const mutation = (result: unknown = { count: 1 }) => vi.fn().mockResolvedValue(result);

describe("user offboarding", () => {
  it("removes personal data while transferring every company board dependency", async () => {
    const tx = {
      user: {
        findUnique: vi.fn(async ({ where }: any) =>
          where.id === "departing"
            ? {
                id: "departing",
                email: "departing@example.test",
                username: "departing-user",
              }
            : { id: "successor", isActive: true },
        ),
        update: mutation({ id: "departing", isActive: false }),
        delete: mutation({ id: "departing" }),
      },
      refreshToken: { updateMany: mutation({ count: 2 }) },
      apiKey: {
        findMany: vi.fn().mockResolvedValue([{ id: "key-1" }]),
        updateMany: mutation({ count: 1 }),
      },
      drawing: { updateMany: mutation({ count: 3 }) },
      s3File: { updateMany: mutation() },
      asset: { updateMany: mutation() },
      drawingPermission: { updateMany: mutation() },
      drawingLinkShare: { updateMany: mutation() },
      collectionShare: { updateMany: mutation() },
      comment: { updateMany: mutation() },
      activityEvent: { updateMany: mutation() },
      libraryItem: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: mutation(),
        deleteMany: mutation(),
      },
      auditLog: { deleteMany: mutation() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: any) => Promise<unknown>) => callback(tx)),
    };

    const result = await offboardUserAndTransferBoards({
      prisma: prisma as any,
      userId: "departing",
      successorUserId: "successor",
      useCompanyArchive: false,
    });

    expect(result).toEqual({
      successorUserId: "successor",
      transferredDrawings: 3,
      revokedApiKeyIds: ["key-1"],
    });
    expect(tx.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: "departing", revoked: false },
      data: { revoked: true },
    });
    expect(tx.apiKey.updateMany).toHaveBeenCalledWith({
      where: { userId: "departing", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(tx.drawing.updateMany).toHaveBeenCalledWith({
      where: { userId: "departing" },
      data: { userId: "successor", collectionId: null },
    });
    expect(tx.s3File.updateMany).toHaveBeenCalledWith({
      where: { userId: "departing" },
      data: { userId: "successor" },
    });
    expect(tx.asset.updateMany).toHaveBeenCalledWith({
      where: { ownerUserId: "departing" },
      data: { ownerUserId: "successor" },
    });
    expect(tx.asset.updateMany).toHaveBeenCalledWith({
      where: { uploadedByUserId: "departing" },
      data: { uploadedByUserId: null },
    });
    expect(tx.drawingPermission.updateMany).toHaveBeenCalledWith({
      where: { createdByUserId: "departing" },
      data: { createdByUserId: "successor" },
    });
    expect(tx.drawingLinkShare.updateMany).toHaveBeenCalledWith({
      where: { createdByUserId: "departing" },
      data: { createdByUserId: "successor" },
    });
    expect(tx.collectionShare.updateMany).toHaveBeenCalledWith({
      where: { createdByUserId: "departing" },
      data: { createdByUserId: "successor" },
    });
    // RED PROBE evidence (see PR HANDOFF): Comment.authorUserId and
    // ActivityEvent.actorUserId are real relations with onDelete: Cascade,
    // unlike the createdByUserId string fields above. Without this
    // reassignment running before tx.user.delete, deleting a departing
    // author's own root comment cascades away every OTHER person's reply
    // nested under it too (Comment.root is also Cascade) -- a silent loss
    // of other people's content, not just the departing account's own.
    expect(tx.comment.updateMany).toHaveBeenCalledWith({
      where: { authorUserId: "departing" },
      data: { authorUserId: "successor" },
    });
    expect(tx.activityEvent.updateMany).toHaveBeenCalledWith({
      where: { actorUserId: "departing" },
      data: { actorUserId: "successor" },
    });
    // Team Library items (NIL-364) transfer to the successor like every
    // other owned resource -- transferOwnedLibraryItems reads this
    // account's own items first (findMany), then the successor's existing
    // item ids to resolve collisions, before reassigning ownership.
    expect(tx.libraryItem.findMany).toHaveBeenCalledWith({
      where: { ownerUserId: "departing" },
      select: { id: true, excalidrawItemId: true },
    });
    expect(tx.auditLog.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { userId: "departing" },
          { resource: { contains: "departing" } },
          { details: { contains: "departing" } },
          { resource: { contains: "departing@example.test" } },
          { details: { contains: "departing@example.test" } },
          { resource: { contains: "departing-user" } },
          { details: { contains: "departing-user" } },
        ],
      },
    });
    expect(tx.user.delete).toHaveBeenCalledWith({
      where: { id: "departing" },
    });
    expect(tx.user.delete.mock.invocationCallOrder[0]).toBeGreaterThan(
      tx.drawing.updateMany.mock.invocationCallOrder[0],
    );
    expect(tx.user.delete.mock.invocationCallOrder[0]).toBeGreaterThan(
      tx.comment.updateMany.mock.invocationCallOrder[0],
    );
  });

  it("creates an inactive company archive when no named successor is chosen", async () => {
    const tx: any = {
      user: {
        findUnique: vi.fn(async ({ where }: any) =>
          where.id === "departing" ? { id: "departing" } : null,
        ),
        create: mutation({ id: "company-archive" }),
        update: mutation(),
        delete: mutation(),
      },
      refreshToken: { updateMany: mutation() },
      apiKey: { findMany: mutation([]), updateMany: mutation() },
      drawing: { updateMany: mutation({ count: 1 }) },
      s3File: { updateMany: mutation() },
      asset: { updateMany: mutation() },
      drawingPermission: { updateMany: mutation() },
      drawingLinkShare: { updateMany: mutation() },
      collectionShare: { updateMany: mutation() },
      comment: { updateMany: mutation() },
      activityEvent: { updateMany: mutation() },
      libraryItem: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: mutation(),
        deleteMany: mutation(),
      },
      auditLog: { deleteMany: mutation() },
    };
    const prisma = {
      $transaction: (callback: (client: any) => Promise<unknown>) => callback(tx),
    };

    const result = await offboardUserAndTransferBoards({
      prisma: prisma as any,
      userId: "departing",
      successorUserId: null,
      useCompanyArchive: true,
    });

    expect(result.successorUserId).toBe("company-archive");
    expect(tx.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        email: COMPANY_ARCHIVE_USER_EMAIL,
        isActive: false,
        role: "USER",
      }),
      select: { id: true },
    });
    expect(tx.drawing.updateMany).toHaveBeenCalledWith({
      where: { userId: "departing" },
      data: { userId: "company-archive", collectionId: null },
    });
  });
});
