/**
 * The document routes, against real Express handlers and a real database.
 *
 * The point of these is the authorization, and authorization is exactly the
 * thing a mocked test proves nothing about.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { PrismaClient } from "../generated/client";
import { getTestPrisma, setupTestDb, cleanupTestDb, createTestUser } from "../__tests__/testUtils";
import { createAsset } from "./assetService";
import { contentDisposition, registerAssetRoutes } from "./assetRoutes";
import type { AssetRouteDeps } from "./assetRoutes";
import { resolveStoragePath } from "./assetStorage";
import { PdfRejectedError } from "./pdfRenderer";
import { buildShareLinkToken, hashShareLinkToken } from "../authz/sharing";

describe("document routes", () => {
  let prisma: PrismaClient;
  let storageDir: string;
  let app: express.Express;
  let owner: any;
  let stranger: any;
  let viewer: any;
  let drawingId: string;
  let assetId: string;
  let actAs: string | null;
  let optimizeUpload: AssetRouteDeps["optimizeUpload"];
  let getPageCalls: Array<{ assetId: string; page: number }>;

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
    await prisma.drawingSnapshotAsset.deleteMany({});
    await prisma.drawingAsset.deleteMany({});
    await prisma.asset.deleteMany({});
    await prisma.storedBlob.deleteMany({});
    await prisma.drawingPermission.deleteMany({});
    await prisma.drawingSnapshot.deleteMany({});
    await prisma.drawing.deleteMany({});
    await prisma.user.deleteMany({});

    storageDir = await mkdtemp(join(tmpdir(), "assetroutes-"));
    owner = await createTestUser(prisma, "owner@example.com");
    stranger = await createTestUser(prisma, "stranger@example.com");
    viewer = await createTestUser(prisma, "viewer@example.com");
    actAs = owner.id;

    const drawing = await prisma.drawing.create({
      data: { name: "Board", elements: "[]", appState: "{}", userId: owner.id },
    });
    drawingId = drawing.id;
    optimizeUpload = undefined;
    getPageCalls = [];

    const created = await createAsset(
      { prisma, storageDir, maxUploadBytes: 1_000_000, maxPerUserBytes: 10_000_000 },
      {
        ownerUserId: owner.id,
        uploadedByUserId: owner.id,
        drawingId,
        kind: "PDF",
        originalName: "Quartalsbericht Q3.pdf",
        mimeType: "application/pdf",
        source: Readable.from([Buffer.from("%PDF-1.4 pretend")]),
      },
    );
    assetId = created.asset.id;
    await prisma.asset.update({ where: { id: assetId }, data: { pageCount: 3 } });
    await prisma.drawingAsset.update({
      where: { drawingId_assetId: { drawingId, assetId } },
      data: { state: "ACTIVE", expiresAt: null },
    });

    app = express();
    app.use(express.json());
    // Stands in for the real auth middleware: the tests care about what the
    // routes do with an identity, not how it was established.
    const attach = (req: any, _res: any, next: any) => {
      if (actAs) req.user = { id: actAs };
      next();
    };
    registerAssetRoutes({
      app,
      prisma,
      requireAuth: (req: any, res: any, next: any) => {
        attach(req, res, () => {});
        if (!req.user) return res.status(401).json({ error: "Unauthorized" });
        next();
      },
      optionalAuth: attach,
      asyncHandler,
      storageDir,
      maxUploadBytes: 10_000_000,
      maxPerUserBytes: 10_000_000,
      // Records every call so tests can prove the renderer was never reached,
      // and mimics what a real Poppler render would do with a non-PDF source
      // (reject it) so a regression that lets a wrong kind through surfaces
      // as a 422 from "the renderer ran", not a silent pass.
      getPage: async (asset: any, page: number) => {
        getPageCalls.push({ assetId: asset.id, page });
        if (asset.kind !== "PDF") {
          throw new PdfRejectedError("Not a PDF");
        }
        return {
          body: Buffer.from(`<svg>page ${page}</svg>`),
          mimeType: "image/svg+xml",
          contentEncoding: null,
        };
      },
      describeUpload: async (asset: any) => {
        // Guards the wiring, not just the shape: this needs the bytes to look
        // at, and the created row does not carry them by itself.
        if (!asset?.blob?.storageKey) {
          throw new Error("describeUpload was given no blob to read");
        }
        return { pageCount: 7 };
      },
      optimizeUpload: async (stored) => (optimizeUpload ? optimizeUpload(stored) : { note: null }),
    });
  });

  const url = (suffix = "") => `/drawings/${drawingId}/assets/${assetId}${suffix}`;
  const upload = (body: Buffer | string, type = "application/pdf", name = "neu.pdf") =>
    request(app)
      .post(`/drawings/${drawingId}/assets?name=${encodeURIComponent(name)}`)
      .set("Content-Type", type)
      .send(body as any);

  describe("who may read a document", () => {
    it("lets the owner read it", async () => {
      const res = await request(app).get(url()).expect(200);
      expect(res.body.name).toBe("Quartalsbericht Q3.pdf");
      expect(res.body.pageCount).toBe(3);
    });

    it("hides it from someone with no access to the board", async () => {
      actAs = stranger.id;
      await request(app).get(url()).expect(404);
    });

    it("hides it from a signed-out visitor", async () => {
      actAs = null;
      await request(app).get(url()).expect(404);
    });

    it("lets someone the board was shared with read it", async () => {
      await prisma.drawingPermission.create({
        data: {
          drawingId,
          granteeUserId: viewer.id,
          permission: "view",
          createdByUserId: owner.id,
        },
      });
      actAs = viewer.id;
      await request(app).get(url()).expect(200);
    });

    it("requires the valid link token and then serves the document to a link guest", async () => {
      const token = buildShareLinkToken();
      await prisma.drawingLinkShare.create({
        data: {
          drawingId,
          permission: "view",
          tokenHash: hashShareLinkToken(token),
          createdByUserId: owner.id,
        },
      });
      actAs = null;

      await request(app).get(url()).expect(404);
      await request(app)
        .get(url())
        .query({ shareToken: "x".repeat(32) })
        .expect(404);
      const response = await request(app).get(url()).query({ shareToken: token }).expect(200);
      expect(response.body.name).toBe("Quartalsbericht Q3.pdf");
    });
  });

  describe("renaming a document", () => {
    it("persists a new download name for an editor", async () => {
      const renamed = await request(app)
        .patch(url())
        .send({ name: "  Workshop brief.pdf  " })
        .expect(200);
      expect(renamed.body.name).toBe("Workshop brief.pdf");

      const metadata = await request(app).get(url()).expect(200);
      expect(metadata.body.name).toBe("Workshop brief.pdf");
      const original = await request(app).get(url("/original")).expect(200);
      expect(original.headers["content-disposition"]).toContain("Workshop%20brief.pdf");
    });

    it("rejects a view-only participant and hides the document from a stranger", async () => {
      await prisma.drawingPermission.create({
        data: {
          drawingId,
          granteeUserId: viewer.id,
          permission: "view",
          createdByUserId: owner.id,
        },
      });
      actAs = viewer.id;
      await request(app).patch(url()).send({ name: "viewer.pdf" }).expect(403);
      actAs = stranger.id;
      await request(app).patch(url()).send({ name: "stranger.pdf" }).expect(404);
    });

    it("rejects empty and control-character names without changing metadata", async () => {
      await request(app).patch(url()).send({ name: "   " }).expect(400);
      await request(app).patch(url()).send({ name: "bad\nname.pdf" }).expect(400);
      const metadata = await request(app).get(url()).expect(200);
      expect(metadata.body.name).toBe("Quartalsbericht Q3.pdf");
    });
  });

  describe("belonging to the board, not just access to some board", () => {
    it("refuses a document that belongs to a different board", async () => {
      const otherBoard = await prisma.drawing.create({
        data: { name: "Other", elements: "[]", appState: "{}", userId: owner.id },
      });
      // The owner may see both boards, but this document is not on this one.
      await request(app).get(`/drawings/${otherBoard.id}/assets/${assetId}`).expect(404);
    });

    it("still serves a document only a kept version still needs", async () => {
      const snapshot = await prisma.drawingSnapshot.create({
        data: { drawingId, version: 1, elements: "[]", appState: "{}" },
      });
      await prisma.drawingSnapshotAsset.create({ data: { snapshotId: snapshot.id, assetId } });
      await prisma.drawingAsset.deleteMany({ where: { assetId } });

      await request(app).get(url()).expect(200);
    });

    it("refuses an id that does not exist without saying so differently", async () => {
      const res = await request(app).get(`/drawings/${drawingId}/assets/does-not-exist`);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Document not found");
    });
  });

  describe("the original", () => {
    it("is sent as a download, never rendered in place", async () => {
      const res = await request(app).get(url("/original")).expect(200);
      expect(res.headers["content-disposition"]).toMatch(/^attachment;/);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["content-security-policy"]).toContain("sandbox");
    });

    it("re-stores content whose deduplicated file went missing", async () => {
      // Identical bytes normally reuse the existing row. If that row's file is
      // gone, reusing it hands the uploader a document that can never be read
      // and no error to explain it, for every future upload of that content.
      const asset = await prisma.asset.findUnique({
        where: { id: assetId },
        include: { blob: true },
      });
      const path = resolveStoragePath(storageDir, asset!.blob.storageKey);
      const bytes = await readFile(path);
      await rm(path);

      const again = await request(app)
        .post(`/drawings/${drawingId}/assets?name=nochmal.pdf`)
        .set("Content-Type", "application/pdf")
        .send(bytes)
        .expect(201);

      const restored = await request(app)
        .get(`/drawings/${drawingId}/assets/${again.body.id}/original`)
        .expect(200);
      expect(restored.body).toEqual(bytes);
      // And the original document, which shares those bytes, reads again too.
      await request(app).get(url("/original")).expect(200);
    });

    it("does not reuse bytes that are being deleted", async () => {
      // Matching content normally reuses the row. A row claimed for deletion is
      // about to lose its file, so adopting it would hand the uploader a
      // document whose bytes vanish moments later.
      const asset = await prisma.asset.findUnique({
        where: { id: assetId },
        include: { blob: true },
      });
      const bytes = await readFile(resolveStoragePath(storageDir, asset!.blob.storageKey));
      await prisma.storedBlob.update({
        where: { id: asset!.blob.id },
        data: { state: "DELETING" },
      });

      const again = await request(app)
        .post(`/drawings/${drawingId}/assets?name=umkaempft.pdf`)
        .set("Content-Type", "application/pdf")
        .send(bytes)
        .expect(201);

      const stored = await prisma.asset.findUnique({
        where: { id: again.body.id },
        include: { blob: true },
      });
      expect(stored!.blob.state).toBe("READY");
      await request(app).get(`/drawings/${drawingId}/assets/${again.body.id}/original`).expect(200);
    });

    it("answers rather than dying when the stored file is gone", async () => {
      // A blob row whose file is missing — a partial restore, a file removed by
      // hand — used to reach an unhandled stream error, and an unhandled stream
      // error ends the process. One absent file must not put everybody off
      // their boards.
      const asset = await prisma.asset.findUnique({
        where: { id: assetId },
        include: { blob: true },
      });
      const path = resolveStoragePath(storageDir, asset!.blob.storageKey);
      const bytes = await readFile(path);
      await rm(path);
      try {
        const res = await request(app).get(url("/original"));
        expect(res.status).toBe(404);
        expect(res.body.error).toBe("Document unavailable");
        // The server is still answering, which is the whole point.
        await request(app).get(`/drawings/${drawingId}/assets/does-not-exist`).expect(404);
      } finally {
        await writeFile(path, bytes);
      }
    });

    it("carries the real filename for clients that can read it", async () => {
      const res = await request(app).get(url("/original")).expect(200);
      expect(res.headers["content-disposition"]).toContain("filename*=UTF-8''");
    });

    it("is not cached by shared caches", async () => {
      const res = await request(app).get(url("/original")).expect(200);
      expect(res.headers["cache-control"]).toContain("private");
      expect(res.headers["vary"]).toContain("Cookie");
    });

    it("answers 304 when the client already has it", async () => {
      const first = await request(app).get(url("/original")).expect(200);
      await request(app).get(url("/original")).set("If-None-Match", first.headers.etag).expect(304);
    });
  });

  describe("pages", () => {
    it("renders a page that exists", async () => {
      const res = await request(app).get(url("/pages/2")).buffer(true).expect(200);
      expect(res.headers["content-type"]).toContain("image/svg+xml");
      expect(Buffer.from(res.body).toString()).toContain("page 2");
    });

    it("refuses a page past the end and says how many there are", async () => {
      const res = await request(app).get(url("/pages/9")).expect(404);
      expect(res.body.message).toContain("3 pages");
    });

    it("refuses a page that is not a positive whole number", async () => {
      await request(app).get(url("/pages/0")).expect(404);
      await request(app).get(url("/pages/-1")).expect(404);
      await request(app).get(url("/pages/abc")).expect(404);
    });

    it("marks pages so nothing can run inside them", async () => {
      const res = await request(app).get(url("/pages/1")).expect(200);
      expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
    });

    it("still renders every page of a PDF up to its real count, and 404s past it", async () => {
      // Green half of the kind-guard counterproof: a PDF must keep working
      // exactly as before, on every in-range page, not just page 1.
      await request(app).get(url("/pages/1")).buffer(true).expect(200);
      await request(app).get(url("/pages/3")).buffer(true).expect(200);
      await request(app).get(url("/pages/4")).expect(404);
      expect(getPageCalls.filter((c) => c.assetId === assetId)).toHaveLength(2);
    });

    it("refuses to render a page of a text document without ever reaching the renderer", async () => {
      // Red half of the kind-guard counterproof. If the guard were instead
      // "reject at upload" (pageCount stuck at null), this asset would never
      // exist to ask for a page from; here it exists, has a real pageCount
      // (used by the widget's own pagination), and the block is still at the
      // page-render route. A regression that removes the kind check would
      // make getPage run and throw PdfRejectedError, turning this 404 into a
      // 422 — the mock is wired so "it rendered" is observable, not silent.
      const created = await upload("plain prose, no markup", "text/plain", "notes.txt").expect(201);
      expect(created.body.pageCount).toBeGreaterThan(0);

      const res = await request(app)
        .get(`/drawings/${drawingId}/assets/${created.body.id}/pages/1`)
        .expect(404);

      expect(res.body.error).toBe("Document not found");
      expect(getPageCalls.filter((c) => c.assetId === created.body.id)).toHaveLength(0);
    });

    it("refuses to render a page of a markdown document without ever reaching the renderer", async () => {
      const created = await upload("# heading\n\nbody text", "text/markdown", "notes.md").expect(
        201,
      );
      expect(created.body.pageCount).toBeGreaterThan(0);

      const res = await request(app)
        .get(`/drawings/${drawingId}/assets/${created.body.id}/pages/1`)
        .expect(404);

      expect(res.body.error).toBe("Document not found");
      expect(getPageCalls.filter((c) => c.assetId === created.body.id)).toHaveLength(0);
    });
  });

  describe("uploading", () => {
    it("accepts a PDF and reports its page count", async () => {
      const res = await upload(Buffer.from("%PDF-1.4 more")).expect(201);
      expect(res.body.pageCount).toBe(7);
      expect(res.body.name).toBe("neu.pdf");
    });

    it("stores the optimized hash and bytes returned by the upload pipeline", async () => {
      const original = Buffer.from("%PDF-1.4 original payload with removable bytes");
      const optimized = Buffer.from("%PDF-1.4 optimized");
      optimizeUpload = async ({ path }) => {
        await writeFile(path, optimized);
        return { note: "smaller" };
      };

      const res = await upload(original).expect(201);
      const asset = await prisma.asset.findUnique({
        where: { id: res.body.id },
        include: { blob: true },
      });

      expect(res.body.sizeBytes).toBe(optimized.length);
      expect(res.body.note).toBe("smaller");
      expect(asset?.blob.sha256).toBe(createHash("sha256").update(optimized).digest("hex"));
      expect(asset?.blob.sizeBytes).toBe(optimized.length);
      expect(await readFile(resolveStoragePath(storageDir, asset!.blob.storageKey))).toEqual(
        optimized,
      );
    });

    it("refuses unsupported media types", async () => {
      const res = await upload("<html>hi</html>", "text/html").expect(415);
      expect(res.body.message).toContain("text/html");
    });

    it("accepts Markdown as UTF-8 text without rendering pages", async () => {
      const markdown = "# Grüße\n\n- eins\n- zwei";
      const res = await upload(markdown, "text/markdown", "notes.md").expect(201);

      expect(res.body).toMatchObject({ kind: "MARKDOWN", name: "notes.md", pageCount: 1 });
      const stored = await prisma.asset.findUnique({ where: { id: res.body.id } });
      expect(stored?.mimeType).toBe("text/markdown; charset=utf-8");
      expect(stored?.pageCount).toBe(1);
    });

    it("uses the text media type as a presentation preference, not content detection", async () => {
      const markdownPreference = await upload(
        "ordinary prose without Markdown syntax",
        "text/markdown",
        "prose.txt",
      ).expect(201);
      const textPreference = await upload(
        "# syntax that could be rendered",
        "text/plain",
        "source.md",
      ).expect(201);

      expect(markdownPreference.body.kind).toBe("MARKDOWN");
      expect(textPreference.body.kind).toBe("TEXT");
    });

    it("rejects a binary file that claims to be Markdown", async () => {
      const binary = Buffer.from([0x23, 0x20, 0x6f, 0x6b, 0, 0xff]);
      const res = await upload(binary, "text/markdown", "malware.md").expect(422);
      expect(res.body.error).toBe("Invalid text document");
    });

    it("limits text uploads independently of the PDF limit", async () => {
      const tooLarge = Buffer.alloc(2 * 1024 * 1024 + 1, 0x61);
      const res = await upload(tooLarge, "text/plain", "large.txt").expect(413);
      expect(res.body.code).toBe("asset-too-large");
      expect(res.body.message).toContain("2 MB");
    });

    it("refuses someone with only view access", async () => {
      await prisma.drawingPermission.create({
        data: {
          drawingId,
          granteeUserId: viewer.id,
          permission: "view",
          createdByUserId: owner.id,
        },
      });
      actAs = viewer.id;
      const res = await upload(Buffer.from("%PDF-1.4 x")).expect(403);
      expect(res.body.message).toContain("not add documents");
    });

    it("refuses a stranger without revealing that the board exists", async () => {
      actAs = stranger.id;
      await upload(Buffer.from("%PDF-1.4 x")).expect(404);
    });

    it("charges the board owner rather than whoever uploaded", async () => {
      await prisma.drawingPermission.create({
        data: {
          drawingId,
          granteeUserId: viewer.id,
          permission: "edit",
          createdByUserId: owner.id,
        },
      });
      actAs = viewer.id;
      const res = await upload(Buffer.from("%PDF-1.4 uploaded by guest")).expect(201);

      const asset = await prisma.asset.findUnique({ where: { id: res.body.id } });
      expect(asset?.ownerUserId).toBe(owner.id);
      expect(asset?.uploadedByUserId).toBe(viewer.id);
    });
  });

  describe("browser-rendered text", () => {
    const uploadMarkdown = async () => {
      const upload = await request(app)
        .post(`/drawings/${drawingId}/assets?name=readme.md`)
        .set("Content-Type", "text/markdown")
        .send("# Safe heading\n\n<script>alert(1)</script>")
        .expect(201);
      return `/drawings/${drawingId}/assets/${upload.body.id}/content`;
    };

    it("serves the original text inline with inert, private response headers", async () => {
      const contentUrl = await uploadMarkdown();
      const res = await request(app).get(contentUrl).expect(200);

      expect(res.text).toContain("<script>alert(1)</script>");
      expect(res.headers["content-type"]).toContain("text/markdown");
      expect(res.headers["content-disposition"]).toMatch(/^inline;/);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
      expect(res.headers["cache-control"]).toContain("private");
      expect(res.headers["vary"]).toContain("Cookie");
    });

    it("applies both board-access and board-ownership checks", async () => {
      const contentUrl = await uploadMarkdown();
      actAs = stranger.id;
      await request(app).get(contentUrl).expect(404);

      actAs = owner.id;
      const otherBoard = await prisma.drawing.create({
        data: { name: "Other", elements: "[]", appState: "{}", userId: owner.id },
      });
      const assetPath = contentUrl.split("/");
      const contentForOtherBoard = `/drawings/${otherBoard.id}/assets/${assetPath[4]}/content`;
      await request(app).get(contentForOtherBoard).expect(404);
    });
  });
});

describe("filenames in headers", () => {
  it("keeps a plain name as it is", () => {
    expect(contentDisposition("attachment", "report.pdf")).toBe(
      `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
    );
  });

  it("replaces characters a header cannot carry", () => {
    const value = contentDisposition("attachment", "Bericht Q3 – Übersicht.pdf");
    expect(value).toContain('filename="Bericht Q3 _ _bersicht.pdf"');
    expect(value).toContain("filename*=UTF-8''Bericht%20Q3%20%E2%80%93%20%C3%9Cbersicht.pdf");
  });

  it("cannot break out of the quoted filename", () => {
    // The quote is the only character that could end the quoted string early;
    // semicolons and spaces inside it are harmless.
    const value = contentDisposition("attachment", 'evil"; download; x="');
    const quoted = value.match(/filename="([^"]*)"/);
    expect(quoted).not.toBeNull();
    expect(quoted![1]).not.toContain('"');
    expect(value).toContain("filename*=UTF-8''evil%22");
  });

  it("falls back to a name when there is nothing usable left", () => {
    expect(contentDisposition("inline", "———")).toContain('filename="___"');
  });
});
