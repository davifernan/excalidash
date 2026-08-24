import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcrypt";
import jwt, { SignOptions } from "jsonwebtoken";
import { StringValue } from "ms";
import { PrismaClient } from "../generated/client";
import { config } from "../config";
import { getTestPrisma, setupTestDb } from "./testUtils";

describe("Drawings - Shared With Me", () => {
  const userAgent = "vitest-drawings-shared";
  let prisma: PrismaClient;
  let app: any;

  beforeAll(async () => {
    setupTestDb();
    prisma = getTestPrisma();
    ({ app } = await import("../index"));

    await prisma.systemConfig.upsert({
      where: { id: "default" },
      update: {
        authEnabled: true,
        registrationEnabled: false,
      },
      create: {
        id: "default",
        authEnabled: true,
        registrationEnabled: false,
      },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("does not include drawings you own even if you have a self permission row", async () => {
    const passwordHash = await bcrypt.hash("password123", 10);

    const userA = await prisma.user.create({
      data: {
        email: "user-a@test.local",
        passwordHash,
        name: "User A",
        role: "USER",
        isActive: true,
      },
      select: { id: true, email: true },
    });

    const userB = await prisma.user.create({
      data: {
        email: "user-b@test.local",
        passwordHash,
        name: "User B",
        role: "USER",
        isActive: true,
      },
      select: { id: true },
    });

    const drawingOwnedByA = await prisma.drawing.create({
      data: {
        name: "Owned by A",
        elements: "[]",
        appState: "{}",
        files: "{}",
        userId: userA.id,
        collectionId: null,
        version: 1,
      },
      select: { id: true },
    });

    const drawingOwnedByB = await prisma.drawing.create({
      data: {
        name: "Owned by B",
        elements: "[]",
        appState: "{}",
        files: "{}",
        userId: userB.id,
        collectionId: null,
        version: 1,
      },
      select: { id: true },
    });

    // Simulate a deployment that stores an owner "self" permission row.
    await prisma.drawingPermission.create({
      data: {
        drawingId: drawingOwnedByA.id,
        granteeUserId: userA.id,
        permission: "edit",
        createdByUserId: userA.id,
      },
    });

    // A real share: drawing owned by B is shared to A.
    await prisma.drawingPermission.create({
      data: {
        drawingId: drawingOwnedByB.id,
        granteeUserId: userA.id,
        permission: "view",
        createdByUserId: userB.id,
      },
    });

    const signOptions: SignOptions = { expiresIn: config.jwtAccessExpiresIn as StringValue };
    const tokenA = jwt.sign(
      { userId: userA.id, email: userA.email, type: "access" },
      config.jwtSecret,
      signOptions,
    );

    const response = await request(app)
      .get("/drawings/shared")
      .set("User-Agent", userAgent)
      .set("Authorization", `Bearer ${tokenA}`);

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body?.drawings)).toBe(true);
    const ids = (response.body.drawings as any[]).map((d) => d.id);
    expect(ids).toContain(drawingOwnedByB.id);
    expect(ids).not.toContain(drawingOwnedByA.id);
  });

  it("still lists an unorganized board shared directly with you once you also have a shared collection (NIL-501)", async () => {
    const passwordHash = await bcrypt.hash("password123", 10);

    const viewer = await prisma.user.create({
      data: {
        email: "viewer-null-collection@test.local",
        passwordHash,
        name: "Viewer",
        role: "USER",
        isActive: true,
      },
      select: { id: true, email: true },
    });
    const boardOwner = await prisma.user.create({
      data: {
        email: "board-owner-null-collection@test.local",
        passwordHash,
        name: "Board Owner",
        role: "USER",
        isActive: true,
      },
      select: { id: true },
    });
    const collectionOwner = await prisma.user.create({
      data: {
        email: "collection-owner-null-collection@test.local",
        passwordHash,
        name: "Collection Owner",
        role: "USER",
        isActive: true,
      },
      select: { id: true },
    });

    // The board that must still show up: owned by someone else, shared
    // directly, and unorganized (collectionId: null).
    const unorganizedSharedBoard = await prisma.drawing.create({
      data: {
        name: "Unorganized, shared directly",
        elements: "[]",
        appState: "{}",
        files: "{}",
        userId: boardOwner.id,
        collectionId: null,
        version: 1,
      },
      select: { id: true },
    });
    await prisma.drawingPermission.create({
      data: {
        drawingId: unorganizedSharedBoard.id,
        granteeUserId: viewer.id,
        permission: "view",
        createdByUserId: boardOwner.id,
      },
    });

    // A shared collection, unrelated to the board above -- its only role
    // here is to make sharedColIds non-empty, which is what turns on the
    // `NOT: { collectionId: { in: sharedColIds } }` clause under test.
    const sharedCollection = await prisma.collection.create({
      data: { name: "Some Other Collection", userId: collectionOwner.id },
      select: { id: true },
    });
    await prisma.collectionShare.create({
      data: {
        collectionId: sharedCollection.id,
        granteeUserId: viewer.id,
        role: "view",
        createdByUserId: collectionOwner.id,
      },
    });

    const signOptions: SignOptions = { expiresIn: config.jwtAccessExpiresIn as StringValue };
    const viewerToken = jwt.sign(
      { userId: viewer.id, email: viewer.email, type: "access" },
      config.jwtSecret,
      signOptions,
    );

    const response = await request(app)
      .get("/drawings/shared")
      .set("User-Agent", userAgent)
      .set("Authorization", `Bearer ${viewerToken}`);

    expect(response.status).toBe(200);
    const ids = (response.body.drawings as any[]).map((d) => d.id);
    expect(ids).toContain(unorganizedSharedBoard.id);
  });
});
