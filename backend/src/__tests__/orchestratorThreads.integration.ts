import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcrypt";
import jwt, { type SignOptions } from "jsonwebtoken";
import type { StringValue } from "ms";
import type { PrismaClient } from "../generated/client";
import { config } from "../config";
import { cleanupTestDb, getTestPrisma, setupTestDb } from "./testUtils";

describe("NIL-679 orchestrator thread audiences over HTTP", () => {
  let prisma: PrismaClient;
  let app: any;

  beforeAll(async () => {
    setupTestDb();
    prisma = getTestPrisma();
    ({ app } = await import("../index"));
    await prisma.systemConfig.upsert({
      where: { id: "default" },
      update: { authEnabled: true, registrationEnabled: false },
      create: { id: "default", authEnabled: true, registrationEnabled: false },
    });
  });
  afterAll(async () => cleanupTestDb(prisma));

  const makeUser = async (email: string, name: string) =>
    prisma.user.create({
      data: {
        email,
        passwordHash: await bcrypt.hash("password123", 10),
        name,
        role: "USER",
        isActive: true,
      },
      select: { id: true, email: true, name: true },
    });

  const tokenFor = (user: { id: string; email: string }) =>
    jwt.sign({ userId: user.id, email: user.email, type: "access" }, config.jwtSecret, {
      expiresIn: config.jwtAccessExpiresIn as StringValue,
    } satisfies SignOptions);

  const clientFor = async (user: { id: string; email: string }) => {
    const agent = request.agent(app);
    const csrf = await agent.get("/csrf-token");
    const auth = `Bearer ${tokenFor(user)}`;
    const mutate = (verb: "post" | "patch", url: string, body: object) =>
      agent[verb](url).set("Authorization", auth).set(csrf.body.header, csrf.body.token).send(body);
    return {
      get: (url: string) => agent.get(url).set("Authorization", auth),
      post: (url: string, body: object) => mutate("post", url, body),
      patch: (url: string, body: object) => mutate("patch", url, body),
    };
  };

  it("persists local history across clients while returning no private row or event to another authorized user", async () => {
    const owner = await makeUser(`nil679-owner-${Date.now()}@test.local`, "Owner");
    const viewer = await makeUser(`nil679-viewer-${Date.now()}@test.local`, "Viewer");
    const drawing = await prisma.drawing.create({
      data: {
        name: "Audience board",
        appState: "{}",
        files: "{}",
        userId: owner.id,
        elements: JSON.stringify([
          {
            id: "shared-card",
            type: "rectangle",
            isDeleted: false,
            customData: {
              excalidash: {
                schemaVersion: 2,
                orchestratorThread: { threadId: "client-reference", title: "Shared" },
              },
            },
          },
        ]),
      },
    });
    await prisma.drawingPermission.create({
      data: {
        drawingId: drawing.id,
        granteeUserId: viewer.id,
        permission: "view",
        createdByUserId: owner.id,
      },
    });
    const ownerFirstDevice = await clientFor(owner);
    const ownerSecondDevice = await clientFor(owner);
    const viewerClient = await clientFor(viewer);

    const local = await ownerFirstDevice.post(
      `/drawings/${drawing.id}/orchestrator-threads/local`,
      {
        anchor: { x: 12, y: 34 },
      },
    );
    expect(local.status).toBe(201);
    expect(local.body.thread.audience).toEqual({ kind: "private", userId: owner.id });
    const privateThreadId = local.body.thread.id;
    expect(
      (
        await ownerFirstDevice.post(
          `/drawings/${drawing.id}/orchestrator-threads/${privateThreadId}/events`,
          { text: "server-saved private history" },
        )
      ).status,
    ).toBe(201);

    const sameOwnerList = await ownerSecondDevice.get(
      `/drawings/${drawing.id}/orchestrator-threads`,
    );
    expect(sameOwnerList.body.threads.map((thread: any) => thread.id)).toContain(privateThreadId);
    const sameOwnerEvents = await ownerSecondDevice.get(
      `/drawings/${drawing.id}/orchestrator-threads/${privateThreadId}/events`,
    );
    expect(sameOwnerEvents.body.events[0].payload.text).toBe("server-saved private history");

    const foreignList = await viewerClient.get(`/drawings/${drawing.id}/orchestrator-threads`);
    expect(foreignList.status).toBe(200);
    expect(foreignList.body.threads.map((thread: any) => thread.id)).not.toContain(privateThreadId);
    const foreignEvents = await viewerClient.get(
      `/drawings/${drawing.id}/orchestrator-threads/${privateThreadId}/events`,
    );
    expect(foreignEvents.status).toBe(404);
    expect(JSON.stringify(foreignEvents.body)).not.toContain("server-saved private history");

    const shared = await ownerFirstDevice.post(
      `/drawings/${drawing.id}/orchestrator-threads/shared`,
      { anchorElementId: "shared-card" },
    );
    expect(shared.status).toBe(201);
    const foreignAfterShared = await viewerClient.get(
      `/drawings/${drawing.id}/orchestrator-threads`,
    );
    expect(foreignAfterShared.body.threads).toEqual([
      expect.objectContaining({ id: shared.body.thread.id, audience: { kind: "drawing" } }),
    ]);
    expect(
      (
        await viewerClient.post(
          `/drawings/${drawing.id}/orchestrator-threads/${shared.body.thread.id}/events`,
          { text: "view access must not publish" },
        )
      ).status,
    ).toBe(403);
  });
});
