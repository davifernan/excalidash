/**
 * NIL-381/NIL-377: PUT /drawings/:id unions an incoming `files` payload with
 * what the board already has instead of replacing it outright. A save's
 * `files` is whatever the client's own scene currently references, not a
 * claim about every file the board has ever had -- replacing loses a file a
 * different tab/session already stored the moment this save's payload does
 * not happen to repeat it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcrypt";
import jwt, { SignOptions } from "jsonwebtoken";
import { StringValue } from "ms";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "../generated/client";
import { config } from "../config";
import { getTestPrisma, setupTestDb } from "./testUtils";
import { buildShareLinkToken, hashShareLinkToken } from "../authz/sharing";

describe("Scene file union-merge on PUT /drawings/:id (NIL-381)", () => {
  const tinyPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+hc2rNAAAAABJRU5ErkJggg==",
    "base64",
  );
  const userAgent = "vitest-scene-files-union-merge";
  let prisma: PrismaClient;
  let app: any;
  let owner: { id: string; email: string };
  let ownerToken: string;
  let ownerAgent: any;
  let csrfHeaderName: string;
  let csrfToken: string;
  let storageDir: string;
  let anonymousAgent: any;
  let anonymousCsrfHeaderName: string;
  let anonymousCsrfToken: string;

  const signAccessToken = (user: { id: string; email: string }) => {
    const signOptions: SignOptions = { expiresIn: config.jwtAccessExpiresIn as StringValue };
    return jwt.sign(
      { userId: user.id, email: user.email, type: "access" },
      config.jwtSecret,
      signOptions,
    );
  };

  beforeAll(async () => {
    setupTestDb();
    prisma = getTestPrisma();
    storageDir = await mkdtemp(join(tmpdir(), "drawing-create-files-"));
    config.assets.storageDir = storageDir;
    ({ app } = await import("../index"));

    await prisma.systemConfig.upsert({
      where: { id: "default" },
      update: {
        authEnabled: true,
        registrationEnabled: false,
        guestUploadEnabled: false,
        guestCommentVisibilityEnabled: true,
      },
      create: {
        id: "default",
        authEnabled: true,
        registrationEnabled: false,
        guestUploadEnabled: false,
        guestCommentVisibilityEnabled: true,
      },
    });

    const passwordHash = await bcrypt.hash("password123", 10);
    owner = await prisma.user.create({
      data: {
        email: "union-merge-owner@test.local",
        passwordHash,
        name: "Owner",
        role: "USER",
        isActive: true,
      },
      select: { id: true, email: true },
    });
    ownerToken = signAccessToken(owner);

    ownerAgent = request.agent(app);
    const csrfRes = await ownerAgent.get("/csrf-token").set("User-Agent", userAgent);
    csrfHeaderName = csrfRes.body.header;
    csrfToken = csrfRes.body.token;
    anonymousAgent = request.agent(app);
    const anonymousCsrf = await anonymousAgent.get("/csrf-token").set("User-Agent", userAgent);
    anonymousCsrfHeaderName = anonymousCsrf.body.header;
    anonymousCsrfToken = anonymousCsrf.body.token;
  }, 120000);

  afterAll(async () => {
    await prisma.$disconnect();
    await rm(storageDir, { recursive: true, force: true });
  });

  const put = (drawingId: string, body: Record<string, unknown>) =>
    ownerAgent
      .put(`/drawings/${drawingId}`)
      .set("User-Agent", userAgent)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set(csrfHeaderName, csrfToken)
      .send(body);

  it("stores an embedded image only after its new drawing exists", async () => {
    const dataURL = `data:image/png;base64,${tinyPng.toString("base64")}`;
    const created = await ownerAgent
      .post("/drawings")
      .set("User-Agent", userAgent)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set(csrfHeaderName, csrfToken)
      .send({
        name: "Embedded Create Board",
        elements: [],
        appState: {},
        files: {
          "embedded-file": {
            id: "embedded-file",
            mimeType: "image/png",
            dataURL,
          },
        },
        preview: `<svg><image href="${dataURL}" /></svg>`,
      });

    expect(created.status).toBe(200);
    const drawingId = created.body.id as string;
    expect(created.body.files["embedded-file"].dataURL).toBe(
      `/api/files/${drawingId}/embedded-file`,
    );
    expect(created.body.preview).toBe(
      `<svg><image href="/api/files/${drawingId}/embedded-file"></image></svg>`,
    );

    const stored = await prisma.drawingFile.findUnique({
      where: { drawingId_fileId: { drawingId, fileId: "embedded-file" } },
      include: { blob: true },
    });
    expect(stored).toMatchObject({ mimeType: "image/png", blob: { purpose: "IMAGE" } });

    const downloaded = await ownerAgent
      .get(`/files/${drawingId}/embedded-file`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .expect(200)
      .expect("Content-Type", /image\/png/);
    expect(downloaded.body).toEqual(tinyPng);
  });

  it("closes the data: URL scene-PUT bypass unless both guest-upload switches are enabled", async () => {
    const created = await ownerAgent
      .post("/drawings")
      .set("User-Agent", userAgent)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set(csrfHeaderName, csrfToken)
      .send({ name: "Guest data URL gate", elements: [], appState: {}, files: {} });
    expect(created.status).toBe(200);

    const drawingId = created.body.id as string;
    const token = buildShareLinkToken();
    await prisma.drawingLinkShare.create({
      data: {
        drawingId,
        permission: "edit",
        tokenHash: hashShareLinkToken(token),
        createdByUserId: owner.id,
      },
    });
    const dataURL = `data:image/png;base64,${tinyPng.toString("base64")}`;
    const attempt = () =>
      anonymousAgent
        .put(`/drawings/${drawingId}`)
        .set("User-Agent", userAgent)
        .set("x-share-token", token)
        .set(anonymousCsrfHeaderName, anonymousCsrfToken)
        .send({
          version: created.body.version,
          elements: [],
          files: {
            "guest-data-url": {
              id: "guest-data-url",
              mimeType: "image/png",
              dataURL,
            },
          },
        });

    const bothOff = await attempt();
    expect(bothOff.status).toBe(403);
    expect(bothOff.body.code).toBe("GUEST_UPLOAD_DISABLED");
    expect(
      await prisma.drawingFile.findUnique({
        where: { drawingId_fileId: { drawingId, fileId: "guest-data-url" } },
      }),
    ).toBeNull();

    await prisma.drawing.update({ where: { id: drawingId }, data: { guestUploadEnabled: true } });
    expect((await attempt()).status).toBe(403);

    await prisma.systemConfig.update({
      where: { id: "default" },
      data: { guestUploadEnabled: true },
    });
    const enabled = await attempt();
    expect(enabled.status).toBe(200);
    expect(enabled.body.files["guest-data-url"].dataURL).toBe(
      `/api/files/${drawingId}/guest-data-url`,
    );
  });

  it("closes the preview-only data: URL bypass unless both guest-upload switches are enabled", async () => {
    await prisma.systemConfig.update({
      where: { id: "default" },
      data: { guestUploadEnabled: false },
    });
    const created = await ownerAgent
      .post("/drawings")
      .set("User-Agent", userAgent)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set(csrfHeaderName, csrfToken)
      .send({ name: "Guest preview data URL gate", elements: [], appState: {}, files: {} });
    expect(created.status).toBe(200);

    const drawingId = created.body.id as string;
    const token = buildShareLinkToken();
    await prisma.drawingLinkShare.create({
      data: {
        drawingId,
        permission: "edit",
        tokenHash: hashShareLinkToken(token),
        createdByUserId: owner.id,
      },
    });
    const dataURL = `data:image/png;base64,${tinyPng.toString("base64")}`;
    const preview = `<svg xmlns="http://www.w3.org/2000/svg"><image href="${dataURL}" /></svg>`;
    const attempt = () =>
      anonymousAgent
        .put(`/drawings/${drawingId}`)
        .set("User-Agent", userAgent)
        .set("x-share-token", token)
        .set(anonymousCsrfHeaderName, anonymousCsrfToken)
        .send({ preview });

    const bothOff = await attempt();
    expect(bothOff.status).toBe(403);
    expect(bothOff.body.code).toBe("GUEST_UPLOAD_DISABLED");
    expect(
      (await prisma.drawing.findUniqueOrThrow({ where: { id: drawingId } })).preview,
    ).toBeNull();

    await prisma.drawing.update({
      where: { id: drawingId },
      data: { guestUploadEnabled: true },
    });
    const instanceStillOff = await attempt();
    expect(instanceStillOff.status).toBe(403);
    expect(instanceStillOff.body.code).toBe("GUEST_UPLOAD_DISABLED");
    expect(
      (await prisma.drawing.findUniqueOrThrow({ where: { id: drawingId } })).preview,
    ).toBeNull();

    await prisma.systemConfig.update({
      where: { id: "default" },
      data: { guestUploadEnabled: true },
    });
    const enabled = await attempt();
    expect(enabled.status).toBe(200);
    expect(enabled.body.preview).toContain(dataURL);
    expect(
      (await prisma.drawing.findUniqueOrThrow({ where: { id: drawingId } })).preview,
    ).toContain(dataURL);
  });

  it("lets a guest save scene text beside an already-persisted inline preview", async () => {
    const dataURL = `data:image/png;base64,${tinyPng.toString("base64")}`;
    const preview = `<svg xmlns="http://www.w3.org/2000/svg"><image href="${dataURL}" /></svg>`;
    const created = await ownerAgent
      .post("/drawings")
      .set("User-Agent", userAgent)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set(csrfHeaderName, csrfToken)
      .send({
        name: "Legacy inline preview",
        elements: [],
        appState: {},
        files: {},
        preview,
      });
    expect(created.status).toBe(200);

    const drawingId = created.body.id as string;
    const token = buildShareLinkToken();
    await prisma.drawingLinkShare.create({
      data: {
        drawingId,
        permission: "edit",
        tokenHash: hashShareLinkToken(token),
        createdByUserId: owner.id,
      },
    });

    const saved = await anonymousAgent
      .put(`/drawings/${drawingId}`)
      .set("User-Agent", userAgent)
      .set("x-share-token", token)
      .set(anonymousCsrfHeaderName, anonymousCsrfToken)
      .send({
        version: created.body.version,
        elements: [{ id: "guest-text", type: "text", text: "Keep this text" }],
        appState: {},
        preview,
      });

    expect(saved.status).toBe(200);
    expect(saved.body.elements).toEqual([
      expect.objectContaining({ id: "guest-text", text: "Keep this text" }),
    ]);
  });

  it("keeps an existing file when a later save's files payload does not repeat it", async () => {
    const created = await ownerAgent
      .post("/drawings")
      .set("User-Agent", userAgent)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set(csrfHeaderName, csrfToken)
      .send({
        name: "Union Merge Board",
        elements: [],
        appState: {},
        files: {
          "file-a": { id: "file-a", mimeType: "image/png", dataURL: "/api/files/x/file-a" },
        },
      });
    expect(created.status).toBe(200);
    const drawingId = created.body.id as string;
    expect(created.body.files["file-a"]).toBeDefined();

    // A second tab's save only knows about a NEW file, "file-b" -- it never
    // even loaded file-a's presence, the same as a stale/independent editor
    // session sending its own current scene.
    const res = await put(drawingId, {
      version: created.body.version,
      elements: [],
      files: { "file-b": { id: "file-b", mimeType: "image/png", dataURL: "/api/files/x/file-b" } },
    });
    expect(res.status).toBe(200);
    expect(res.body.files["file-a"]).toBeDefined();
    expect(res.body.files["file-b"]).toBeDefined();
  });

  it("an empty entry for an existing fileId does not blank it out", async () => {
    const created = await ownerAgent
      .post("/drawings")
      .set("User-Agent", userAgent)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set(csrfHeaderName, csrfToken)
      .send({
        name: "Union Merge Board 2",
        elements: [],
        appState: {},
        files: {
          "file-a": { id: "file-a", mimeType: "image/png", dataURL: "/api/files/x/file-a" },
        },
      });
    const drawingId = created.body.id as string;

    const res = await put(drawingId, {
      version: created.body.version,
      elements: [],
      files: { "file-a": {} },
    });
    expect(res.status).toBe(200);
    expect(res.body.files["file-a"]).toEqual({
      id: "file-a",
      mimeType: "image/png",
      dataURL: "/api/files/x/file-a",
    });
  });

  it("a real re-upload of the same fileId still overwrites it", async () => {
    const created = await ownerAgent
      .post("/drawings")
      .set("User-Agent", userAgent)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set(csrfHeaderName, csrfToken)
      .send({
        name: "Union Merge Board 3",
        elements: [],
        appState: {},
        files: {
          "file-a": { id: "file-a", mimeType: "image/png", dataURL: "/api/files/x/file-a" },
        },
      });
    const drawingId = created.body.id as string;

    const res = await put(drawingId, {
      version: created.body.version,
      elements: [],
      files: { "file-a": { id: "file-a", mimeType: "image/png", dataURL: "/api/files/y/file-a" } },
    });
    expect(res.status).toBe(200);
    expect(res.body.files["file-a"].dataURL).toBe("/api/files/y/file-a");
  });

  it("returns a conflict, not a server error, for a stale Markdown asset reference", async () => {
    const created = await ownerAgent
      .post("/drawings")
      .set("User-Agent", userAgent)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set(csrfHeaderName, csrfToken)
      .send({ name: "Stale Markdown reference", elements: [], appState: {}, files: {} });

    const response = await put(created.body.id, {
      version: created.body.version,
      elements: [
        {
          id: "stale-markdown-widget",
          type: "embeddable",
          link: "excalidash://asset-widget",
          customData: {
            excalidash: {
              schemaVersion: 2,
              widget: { kind: "markdown", assetId: "replaced-asset-id" },
            },
          },
        },
      ],
      appState: {},
      files: {},
    });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: "STALE_DOCUMENT_ASSET_REFERENCE",
      error: "Conflict",
    });
  });
});
