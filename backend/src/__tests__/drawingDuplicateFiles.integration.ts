/**
 * Duplicating a board must carry over its NIL-381 board images, not just its
 * legacy S3File-backed ones. cloneS3FileReferences (drawingRouteContext.ts)
 * only ever queried prisma.s3File -- a board whose only images went through
 * the new PUT /files/:drawingId/:fileId path lost them silently on
 * duplicate, because the old S3 path kept working and nothing failed loudly.
 * Found in review of PR #77 (Hans-Friedrich, NIL-503).
 *
 * Wired directly against the real route handlers (registerFileRoutes,
 * registerDrawingDeleteDuplicateRoutes via createDrawingRouteContext) and a
 * real database + real disk, same reasoning as files.integration.ts: this is
 * exactly an authz/storage-reference bug a mock would prove nothing about.
 * Not routed through the full app (../index) because that pulls in
 * config.ts's production ASSET_STORAGE_DIR default, which this sandbox
 * cannot write to.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrismaClient } from "../generated/client";
import { getTestPrisma, setupTestDb, cleanupTestDb, createTestUser } from "./testUtils";
import { registerFileRoutes } from "../routes/files";
import { registerDrawingDeleteDuplicateRoutes } from "../routes/dashboard/drawingDeleteDuplicateRoutes";
import { createDrawingRouteContext } from "../routes/dashboard/drawingRouteContext";

describe("Board duplicate carries over DrawingFile-backed images (NIL-503 review)", () => {
  let prisma: PrismaClient;
  let storageDir: string;
  let app: express.Express;
  let owner: any;
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
    await prisma.drawing.deleteMany({});
    await prisma.user.deleteMany({});

    storageDir = await mkdtemp(join(tmpdir(), "duplicatefiles-"));
    owner = await createTestUser(prisma, "duplicate-files-owner@example.com");
    actAs = owner.id;

    const attach = (req: any, _res: any, next: any) => {
      if (actAs) req.user = { id: actAs };
      next();
    };
    const requireAuth = (req: any, res: any, next: any) => {
      attach(req, res, () => {});
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });
      next();
    };

    app = express();
    registerFileRoutes(app, {
      prisma,
      requireAuth,
      optionalAuth: attach,
      asyncHandler,
      storageDir,
      maxImageUploadBytes: 1_000_000,
      maxPerUserBytes: 10_000_000,
    });

    const context = createDrawingRouteContext({
      prisma,
      config: { enableAuditLogging: false },
      ensureTrashCollection: async () => undefined,
      invalidateDrawingsCache: () => undefined,
      logAuditEvent: async () => undefined,
      parseJsonField: (raw: string | null | undefined, fallback: unknown) =>
        raw ? JSON.parse(raw) : fallback,
      collaborationAccess: { recheckDrawingAccess: async () => undefined },
    } as any);
    registerDrawingDeleteDuplicateRoutes(app, { ...context, requireAuth, asyncHandler } as any);
    app.use((err: any, _req: any, res: any, _next: any) => {
      res.status(500).json({ error: err.message, stack: err.stack });
    });
  });

  const png = Buffer.from("duplicate-me-png-bytes");

  it("REAL BUG: a duplicated board can still fetch an image the original uploaded via the board-image route", async () => {
    const drawing = await prisma.drawing.create({
      data: {
        name: "Board with an image",
        elements: "[]",
        appState: "{}",
        userId: owner.id,
        files: "{}",
      },
    });

    const upload = await request(app)
      .put(`/files/${drawing.id}/img-1`)
      .set("Content-Type", "image/png")
      .send(png);
    expect(upload.status).toBe(200);

    await prisma.drawing.update({
      where: { id: drawing.id },
      data: {
        files: JSON.stringify({
          "img-1": {
            id: "img-1",
            mimeType: "image/png",
            dataURL: `/api/files/${drawing.id}/img-1`,
          },
        }),
      },
    });

    const duplicated = await request(app).post(`/drawings/${drawing.id}/duplicate`).send();
    expect(duplicated.status, JSON.stringify(duplicated.body)).toBe(200);
    const duplicateId = duplicated.body.id as string;
    expect(duplicateId).not.toBe(drawing.id);

    // The duplicate's own `files` entry must point at ITS OWN drawingId --
    // pointing back at the original would mean the "copy" is secretly still
    // reading the source board's storage, not a real duplicate.
    expect(duplicated.body.files["img-1"].dataURL).toBe(`/api/files/${duplicateId}/img-1`);

    const duplicateFileRow = await prisma.drawingFile.findUnique({
      where: { drawingId_fileId: { drawingId: duplicateId, fileId: "img-1" } },
    });
    expect(duplicateFileRow).toBeTruthy();

    const fetched = await request(app).get(`/files/${duplicateId}/img-1`);
    expect(fetched.status).toBe(200);
    expect(Buffer.compare(fetched.body, png)).toBe(0);
  });
});
