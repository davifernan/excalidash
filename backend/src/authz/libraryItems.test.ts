import bcrypt from "bcrypt";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getTestPrisma, setupTestDb } from "../__tests__/testUtils";
import { PrismaClient } from "../generated/client";
import { transferOwnedLibraryItems } from "./libraryItems";

let prisma: PrismaClient;

describe("transferOwnedLibraryItems", () => {
  let departing: { id: string };
  let successor: { id: string };

  beforeAll(async () => {
    setupTestDb();
    prisma = getTestPrisma();
    const hash = await bcrypt.hash("password", 10);
    departing = await prisma.user.create({
      data: { email: "departing@library-transfer.com", passwordHash: hash, name: "Departing" },
    });
    successor = await prisma.user.create({
      data: { email: "successor@library-transfer.com", passwordHash: hash, name: "Successor" },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.libraryItem.deleteMany({});
  });

  it("reassigns both personal and team items to the successor", async () => {
    await prisma.libraryItem.createMany({
      data: [
        {
          id: "row-personal",
          excalidrawItemId: "item-personal",
          name: "Personal",
          visibility: "personal",
          ownerUserId: departing.id,
          excalidrawData: "{}",
        },
        {
          id: "row-team",
          excalidrawItemId: "item-team",
          name: "Team",
          visibility: "team",
          ownerUserId: departing.id,
          excalidrawData: "{}",
        },
      ],
    });

    const count = await transferOwnedLibraryItems({
      db: prisma,
      fromUserId: departing.id,
      toUserId: successor.id,
    });

    expect(count).toBe(2);
    const rows = await prisma.libraryItem.findMany({ orderBy: { id: "asc" } });
    expect(rows.every((row) => row.ownerUserId === successor.id)).toBe(true);
  });

  it("drops the departing account's duplicate instead of crashing on the unique constraint when the successor already owns the same item id", async () => {
    await prisma.libraryItem.create({
      data: {
        id: "row-successor",
        excalidrawItemId: "shared-template",
        name: "Successor's copy",
        visibility: "personal",
        ownerUserId: successor.id,
        excalidrawData: "{}",
      },
    });
    await prisma.libraryItem.create({
      data: {
        id: "row-departing",
        excalidrawItemId: "shared-template",
        name: "Departing's copy",
        visibility: "personal",
        ownerUserId: departing.id,
        excalidrawData: "{}",
      },
    });

    // Must not throw a unique-constraint violation.
    const count = await transferOwnedLibraryItems({
      db: prisma,
      fromUserId: departing.id,
      toUserId: successor.id,
    });

    expect(count).toBe(0);
    const rows = await prisma.libraryItem.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].ownerUserId).toBe(successor.id);
    expect(rows[0].id).toBe("row-successor");
  });
});
