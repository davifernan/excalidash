/**
 * NIL-289/NIL-365 negative path, named explicitly in the package kickoff:
 * "ein abgelaufener Gastlink findet nichts". Real database, not a mocked
 * Prisma client -- `getActiveLinkShareAccess`'s expiry check
 * (`OR: [{ expiresAt: null }, { expiresAt: { gt: now } }]`) is enforced by
 * the database itself; a mock that returns a canned row regardless of
 * `where` would report green even if that filter were silently dropped.
 */
import bcrypt from "bcrypt";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getTestPrisma, setupTestDb } from "../__tests__/testUtils";
import { PrismaClient } from "../generated/client";
import { buildShareLinkToken, getDrawingAccess, hashShareLinkToken } from "./sharing";

let prisma: PrismaClient;

describe("getDrawingAccess: expired and revoked guest links", () => {
  let owner: { id: string };
  let drawingId: string;

  beforeAll(async () => {
    setupTestDb();
    prisma = getTestPrisma();
    const hash = await bcrypt.hash("password", 10);
    owner = await prisma.user.create({
      data: { email: "link-expiry-owner@test.com", passwordHash: hash, name: "Owner" },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.drawingLinkShare.deleteMany({});
    await prisma.drawing.deleteMany({});
    const drawing = await prisma.drawing.create({
      data: { name: "Board", elements: "[]", appState: "{}", userId: owner.id },
    });
    drawingId = drawing.id;
  });

  it("an active, unexpired link grants access", async () => {
    const token = buildShareLinkToken();
    await prisma.drawingLinkShare.create({
      data: {
        drawingId,
        permission: "view",
        tokenHash: hashShareLinkToken(token),
        createdByUserId: owner.id,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const access = await getDrawingAccess({
      prisma,
      principal: null,
      drawingId,
      shareToken: token,
    });

    expect(access).toBe("view");
  });

  it("an expired link grants nothing -- not even a downgraded level", async () => {
    const token = buildShareLinkToken();
    await prisma.drawingLinkShare.create({
      data: {
        drawingId,
        permission: "edit",
        tokenHash: hashShareLinkToken(token),
        createdByUserId: owner.id,
        expiresAt: new Date(Date.now() - 60_000), // expired one minute ago
      },
    });

    const access = await getDrawingAccess({
      prisma,
      principal: null,
      drawingId,
      shareToken: token,
    });

    expect(access).toBe("none");
  });

  it("a revoked link grants nothing even before its expiry", async () => {
    const token = buildShareLinkToken();
    await prisma.drawingLinkShare.create({
      data: {
        drawingId,
        permission: "edit",
        tokenHash: hashShareLinkToken(token),
        createdByUserId: owner.id,
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: new Date(),
      },
    });

    const access = await getDrawingAccess({
      prisma,
      principal: null,
      drawingId,
      shareToken: token,
    });

    expect(access).toBe("none");
  });
});
