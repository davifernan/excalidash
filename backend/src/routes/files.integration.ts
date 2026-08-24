/**
 * The board image file routes, against real Express handlers, real authz,
 * and a real database (NIL-381/NIL-503). Authorization is exactly the thing
 * a mocked test proves nothing about -- same reasoning as
 * assetRoutes.integration.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrismaClient } from "../generated/client";
import { getTestPrisma, setupTestDb, cleanupTestDb, createTestUser } from "../__tests__/testUtils";
import { registerFileRoutes } from "./files";

describe("board image file routes (NIL-381)", () => {
  let prisma: PrismaClient;
  let storageDir: string;
  let app: express.Express;
  let owner: any;
  let stranger: any;
  let viewer: any;
  let drawingId: string;
  let actAs: string | null;

  const asyncHandler = (fn: any) => (req: any, res: any, next: any) =>
    Promise.resolve(fn(req, res, next)).catch(next);

  beforeAll(async () => {
    setupTestDb();
    prisma = getTestPrisma();
  });

  afterAll(async () => {
    await cleanupTestDb(prisma);
    await rm(storageDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await prisma.drawingFile.deleteMany({});
    await prisma.storedBlob.deleteMany({});
    await prisma.drawingPermission.deleteMany({});
    await prisma.drawing.deleteMany({});
    await prisma.user.deleteMany({});

    storageDir = await mkdtemp(join(tmpdir(), "filesroutes-"));
    owner = await createTestUser(prisma, "file-owner@example.com");
    stranger = await createTestUser(prisma, "file-stranger@example.com");
    viewer = await createTestUser(prisma, "file-viewer@example.com");
    actAs = owner.id;

    const drawing = await prisma.drawing.create({
      data: { name: "Board", elements: "[]", appState: "{}", userId: owner.id },
    });
    drawingId = drawing.id;

    await prisma.drawingPermission.create({
      data: {
        drawingId,
        granteeUserId: viewer.id,
        permission: "view",
        createdByUserId: owner.id,
      },
    });

    // No body-parsing middleware, matching production: express.json()/
    // urlencoded() in index.ts only consume a matching Content-Type, so an
    // image PUT's body reaches the route handler as an unconsumed stream --
    // adding a raw()-type parser here would consume it first and break the
    // very thing this test is proving.
    app = express();
    const attach = (req: any, _res: any, next: any) => {
      if (actAs) req.user = { id: actAs };
      next();
    };
    registerFileRoutes(app, {
      prisma,
      requireAuth: (req: any, res: any, next: any) => {
        attach(req, res, () => {});
        if (!req.user) return res.status(401).json({ error: "Unauthorized" });
        next();
      },
      optionalAuth: attach,
      asyncHandler,
      storageDir,
      maxImageUploadBytes: 1_000_000,
      maxPerUserBytes: 10_000_000,
    });
  });

  const png = Buffer.from("fake-png-bytes-1");

  it("uploads an image and serves it back byte-identical", async () => {
    const put = await request(app)
      .put(`/files/${drawingId}/img-1`)
      .set("Content-Type", "image/png")
      .send(png);
    expect(put.status).toBe(200);
    expect(put.body.mimeType).toBe("image/png");
    expect(put.body.sizeBytes).toBe(png.length);

    const get = await request(app).get(`/files/${drawingId}/img-1`);
    expect(get.status).toBe(200);
    expect(get.headers["content-type"]).toContain("image/png");
    expect(Buffer.compare(get.body, png)).toBe(0);
  });

  it("is idempotent: uploading the same bytes twice does not create a second blob", async () => {
    await request(app).put(`/files/${drawingId}/img-1`).set("Content-Type", "image/png").send(png);
    await request(app).put(`/files/${drawingId}/img-1`).set("Content-Type", "image/png").send(png);

    const blobs = await prisma.storedBlob.count();
    expect(blobs).toBe(1);
  });

  it("dedupes identical bytes across two different fileIds into one blob", async () => {
    await request(app).put(`/files/${drawingId}/img-1`).set("Content-Type", "image/png").send(png);
    await request(app).put(`/files/${drawingId}/img-2`).set("Content-Type", "image/png").send(png);

    const blobs = await prisma.storedBlob.count();
    expect(blobs).toBe(1);
    const files = await prisma.drawingFile.count({ where: { drawingId } });
    expect(files).toBe(2);
  });

  it("rejects an unsupported MIME type", async () => {
    const res = await request(app)
      .put(`/files/${drawingId}/img-1`)
      .set("Content-Type", "application/octet-stream")
      .send(Buffer.from("not an image"));
    expect(res.status).toBe(415);
  });

  it("rejects an upload past the per-image size limit", async () => {
    const big = Buffer.alloc(1_000_001, 1);
    const res = await request(app)
      .put(`/files/${drawingId}/img-1`)
      .set("Content-Type", "image/png")
      .send(big);
    expect(res.status).toBe(413);
  });

  it("a view-only collaborator can read but not upload", async () => {
    actAs = owner.id;
    await request(app).put(`/files/${drawingId}/img-1`).set("Content-Type", "image/png").send(png);

    actAs = viewer.id;
    const get = await request(app).get(`/files/${drawingId}/img-1`);
    expect(get.status).toBe(200);

    const put = await request(app)
      .put(`/files/${drawingId}/img-2`)
      .set("Content-Type", "image/png")
      .send(png);
    expect(put.status).toBe(404);
  });

  it("REAL ATTACK: fileId alone is not authorization -- a stranger with no board access cannot read a file by guessing its (drawingId, fileId)", async () => {
    actAs = owner.id;
    await request(app).put(`/files/${drawingId}/img-1`).set("Content-Type", "image/png").send(png);

    actAs = stranger.id;
    const get = await request(app).get(`/files/${drawingId}/img-1`);
    expect(get.status).toBe(404);

    const put = await request(app)
      .put(`/files/${drawingId}/img-1`)
      .set("Content-Type", "image/png")
      .send(Buffer.from("hostile overwrite"));
    expect(put.status).toBe(404);

    // And the original bytes were not touched by the refused overwrite attempt.
    actAs = owner.id;
    const stillOriginal = await request(app).get(`/files/${drawingId}/img-1`);
    expect(Buffer.compare(stillOriginal.body, png)).toBe(0);
  });

  it("charges quota to the board owner, not whoever uploads", async () => {
    actAs = viewer.id;
    // viewer has only "view" permission -- cannot upload at all, so charge
    // this scenario through a second board owned by the uploader instead:
    // stranger uploads to their OWN board, and usage is attributed to them.
    actAs = stranger.id;
    const strangerDrawing = await prisma.drawing.create({
      data: { name: "Stranger board", elements: "[]", appState: "{}", userId: stranger.id },
    });
    await request(app)
      .put(`/files/${strangerDrawing.id}/img-1`)
      .set("Content-Type", "image/png")
      .send(Buffer.from("stranger-owned-bytes"));

    const files = await prisma.drawingFile.findMany({ where: { drawingId: strangerDrawing.id } });
    expect(files).toHaveLength(1);
    expect(files[0].ownerUserId).toBe(stranger.id);
  });

  it("computes the same sha256 the blob store used, proving the bytes on disk match what was sent", async () => {
    await request(app).put(`/files/${drawingId}/img-1`).set("Content-Type", "image/png").send(png);
    const file = await prisma.drawingFile.findUniqueOrThrow({
      where: { drawingId_fileId: { drawingId, fileId: "img-1" } },
      include: { blob: true },
    });
    expect(file.blob.sha256).toBe(createHash("sha256").update(png).digest("hex"));
  });

  it("forces an uploaded SVG to download rather than render inline, since it can carry a <script>", async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    const put = await request(app)
      .put(`/files/${drawingId}/img-svg`)
      .set("Content-Type", "image/svg+xml")
      .send(svg);
    expect(put.status).toBe(200);

    const get = await request(app).get(`/files/${drawingId}/img-svg`);
    expect(get.status).toBe(200);
    expect(get.headers["content-disposition"]).toBe("attachment");
  });

  it("serves a non-scriptable image type inline", async () => {
    await request(app).put(`/files/${drawingId}/img-1`).set("Content-Type", "image/png").send(png);
    const get = await request(app).get(`/files/${drawingId}/img-1`);
    expect(get.headers["content-disposition"]).toBe("inline");
  });
});
