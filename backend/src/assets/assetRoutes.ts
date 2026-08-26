/**
 * Serving documents.
 * Every route here answers two questions, not one: may this person see this
 * board, and does this document actually belong to that board. The second is
 * not redundant — without it anyone with access to any board could fetch any
 * document by guessing its id, and ids are the only thing standing between
 * someone and a colleague's contract.
 *
 * Both answers come from the database, never from client-written board contents.
 */
import type { Express, Request, Response } from "express";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import {
  canEditDrawing,
  canViewDrawing,
  getDrawingAccess,
  shareLinkTokenFromRequest,
} from "../authz/sharing";
import { resolveStoragePath } from "./assetStorage";
import { logger } from "../logger";
import type { StoredFile } from "./assetStorage";
import {
  AssetTooLargeError,
  QuotaExceededError,
  captureSnapshotAssets,
  createAsset,
  usedBytesFor,
} from "./assetService";
import { PdfRejectedError } from "./pdfRenderer";
import { QueueAbortedError, QueueCapacityError } from "./pageCache";
import { InvalidTextDocumentError, MAX_TEXT_UPLOAD_BYTES, validatedTextUpload } from "./textUpload";
import { paginateDocumentSource } from "./documentPagination";
import { syncDrawingDocumentState } from "./documentWidgetState";
import { readWidgetRecord, withWidgetRecord } from "./customDataSchema";
import type { DocumentEditLockRegistry } from "../server/documentEditLocks";
import {
  DOCUMENT_EDIT_LOCK_EVENT,
  documentEditLockSnapshot,
} from "../server/socketDocumentEditLocks";
import { encodeSnapshotField } from "../snapshots/snapshotCodec";
import { pruneDrawingSnapshots } from "../snapshots/snapshotRetention";
import { config } from "../config";
import { requestIdOf } from "../middleware/requestId";

const ID = /^[\w-]{1,64}$/;
const MAX_ASSET_NAME_LENGTH = 255;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const UPLOAD_PRESENTATIONS = {
  "application/pdf": { kind: "PDF" as const, fallbackName: "document.pdf" },
  "text/markdown": { kind: "MARKDOWN" as const, fallbackName: "document.md" },
  "text/plain": { kind: "TEXT" as const, fallbackName: "document.txt" },
};

/**
 * Select how an upload should be presented. For text this deliberately records
 * the client's preference; it does not claim that the bytes prove Markdown.
 */
export function requestedUploadPresentation(contentType: unknown) {
  const mediaType = String(contentType ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  return {
    mediaType,
    presentation: UPLOAD_PRESENTATIONS[mediaType as keyof typeof UPLOAD_PRESENTATIONS],
  };
}

export type AssetRouteDeps = {
  app: Express;
  prisma: any;
  requireAuth: any;
  optionalAuth: any;
  asyncHandler: (fn: any) => any;
  storageDir: string;
  maxUploadBytes: number;
  maxPerUserBytes: number;
  /** Renders and caches a page, returning what to send. */
  getPage: (
    asset: any,
    page: number,
    signal?: AbortSignal,
  ) => Promise<{
    body: Buffer;
    mimeType: string;
    contentEncoding: string | null;
  }>;
  /** Reads a document's page count after upload. */
  describeUpload: (asset: any) => Promise<{ pageCount: number | null }>;
  /**
   * Rebuilds the stored file smaller where that helps, and reports what
   * changed so the stored size stays honest.
   */
  optimizeUpload?: (
    stored: Readonly<StoredFile & { path: string }>,
  ) => Promise<{ note: string | null }>;
  /** Shared with Socket.IO; required for the enforced Markdown write path. */
  documentEditLocks?: DocumentEditLockRegistry;
  io?: any;
  invalidateDrawingsCache?: () => void;
};

const principalOf = (req: Request) =>
  req.user?.authCredentialType === "bootstrap" && req.user.id
    ? { kind: "user" as const, userId: req.user.id, allowInactive: true }
    : (req.principal ?? (req.user?.id ? { kind: "user" as const, userId: req.user.id } : null));

/**
 * The document, if this request is allowed to have it.
 *
 * Returns null rather than distinguishing "no such document" from "not yours",
 * so a caller cannot use the difference to find out what exists.
 */
async function authorizedAsset(deps: AssetRouteDeps, req: Request) {
  const { drawingId, assetId } = req.params;
  if (!ID.test(drawingId) || !ID.test(assetId)) return null;

  const access = await getDrawingAccess({
    prisma: deps.prisma,
    principal: principalOf(req),
    drawingId,
    shareToken: shareLinkTokenFromRequest(req),
  });
  if (!canViewDrawing(access)) return null;

  // ACTIVE is the persisted invariant that the live board references this
  // document. Viewers may only follow that live reference; editors can also
  // reach pending uploads and documents retained solely for version history.
  const link = await deps.prisma.drawingAsset.findUnique({
    where: { drawingId_assetId: { drawingId, assetId } },
  });
  if (link?.state !== "ACTIVE" && !canEditDrawing(access)) return null;
  if (!link) {
    const viaSnapshot = await deps.prisma.drawingSnapshotAsset.findFirst({
      where: { assetId, snapshot: { drawingId } },
      select: { assetId: true },
    });
    if (!viaSnapshot) return null;
  }

  const asset = await deps.prisma.asset.findUnique({
    where: { id: assetId },
    include: { blob: true },
  });
  if (!asset || asset.status !== "READY") return null;
  return { asset, access, drawingId, link };
}

const normalizedAssetName = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (!name || name.length > MAX_ASSET_NAME_LENGTH || CONTROL_CHARACTER.test(name)) return null;
  return name;
};

const bumpedWidgetElement = (
  element: unknown,
  expectedAssetId: string,
  nextAssetId: string,
): Record<string, unknown> | null => {
  if (
    !element ||
    typeof element !== "object" ||
    (element as any).isDeleted ||
    (element as any).type !== "embeddable" ||
    (element as any).link !== "excalidash://asset-widget"
  ) {
    return null;
  }
  const widget = readWidgetRecord(element);
  if (!widget || widget.kind !== "markdown" || widget.assetId !== expectedAssetId) return null;
  const current = element as Record<string, unknown>;
  return {
    ...withWidgetRecord(current, { kind: "markdown", assetId: nextAssetId }),
    version: (typeof current.version === "number" ? current.version : 0) + 1,
    versionNonce: Math.floor(Math.random() * 2 ** 31),
    updated: Date.now(),
  };
};

type MarkdownWidgetAssetReplacement = {
  elements: Record<string, unknown>[];
  replacedElements: Record<string, unknown>[];
};

export const replaceMarkdownWidgetAsset = (
  elements: unknown,
  elementId: string,
  expectedAssetId: string,
  nextAssetId: string,
): MarkdownWidgetAssetReplacement | null => {
  if (!Array.isArray(elements)) return null;
  const requestedElement = elements.find(
    (element) => element && typeof element === "object" && (element as any).id === elementId,
  );
  if (!requestedElement || !bumpedWidgetElement(requestedElement, expectedAssetId, nextAssetId)) {
    return null;
  }

  const replacedElements: Record<string, unknown>[] = [];
  const next = elements.map((element) => {
    const updated = bumpedWidgetElement(element, expectedAssetId, nextAssetId);
    if (!updated) return element;
    replacedElements.push(updated);
    return updated;
  });
  return { elements: next as Record<string, unknown>[], replacedElements };
};

/** A filename safe to put in a header, plus the exact one for clients that can read it. */
export function contentDisposition(kind: "inline" | "attachment", filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "document";
  const encoded = encodeURIComponent(filename);
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * Send a stored file, and survive it not being there.
 *
 * `pipe` does not carry a read error to the response: the stream throws, and an
 * unhandled stream error takes the whole process with it. A single blob missing
 * from disk — a partial restore, a file removed by hand, a write that failed —
 * would put every user off the board, so the error is answered instead.
 */
export function streamStoredFile(res: Response, path: string): void {
  const stream = createReadStream(path);
  stream.on("error", (err) => {
    logger.error("cannot read stored asset", { path, error: err });
    if (res.headersSent) {
      res.destroy();
      return;
    }
    // The file's own headers were set before streaming began. Left in place,
    // Content-Encoding would have the client try to decompress this answer.
    for (const header of ["Content-Encoding", "Content-Disposition", "Content-Type", "ETag"]) {
      res.removeHeader(header);
    }
    res.status(404).json({
      error: "Document unavailable",
      message: "The stored file for this document could not be read.",
    });
  });
  stream.pipe(res);
}

export function registerAssetRoutes(deps: AssetRouteDeps): void {
  const { app, asyncHandler } = deps;

  // Upload. The body is the file itself rather than a multipart form: there is
  // one file, and streaming it straight to disk avoids buffering 30 MB in
  // memory or writing it twice.
  app.post(
    "/drawings/:drawingId/assets",
    deps.requireAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const { drawingId } = req.params;
      if (!ID.test(drawingId)) return res.status(404).json({ error: "Drawing not found" });

      const drawing = await deps.prisma.drawing.findUnique({
        where: { id: drawingId },
        select: { userId: true },
      });
      const access = await getDrawingAccess({
        prisma: deps.prisma,
        principal: principalOf(req),
        drawingId,
        shareToken: shareLinkTokenFromRequest(req),
      });
      if (!drawing || !canViewDrawing(access)) {
        return res.status(404).json({ error: "Drawing not found" });
      }
      if (!canEditDrawing(access)) {
        return res.status(403).json({
          error: "Read-only access",
          message: "You can view this board but not add documents to it.",
        });
      }

      const { mediaType: requestedPresentationType, presentation: uploadPresentation } =
        requestedUploadPresentation(req.headers["content-type"]);
      if (!uploadPresentation) {
        return res.status(415).json({
          error: "Unsupported file type",
          message: `Only PDF, Markdown, and text documents can be added, not "${requestedPresentationType || "unknown"}".`,
        });
      }

      // For UTF-8 documents Content-Type is a client-selected presentation
      // preference, not a fact inferred from the bytes. Plain prose is valid
      // Markdown and Markdown syntax can be shown as plain text, so a content
      // heuristic would silently override intentional choices.
      const name =
        typeof req.query.name === "string" ? req.query.name : uploadPresentation.fallbackName;
      const isText = uploadPresentation.kind !== "PDF";
      const textChunks: Buffer[] = [];
      const source = isText
        ? Readable.from(
            (async function* () {
              for await (const chunk of validatedTextUpload(req)) {
                textChunks.push(chunk);
                yield chunk;
              }
            })(),
          )
        : req;

      try {
        // Quota is charged to whoever owns the board, not whoever dropped the
        // file, so a guest with edit access cannot spend their own allowance on
        // someone else's board or vice versa.
        const created = await createAsset(
          {
            prisma: deps.prisma,
            storageDir: deps.storageDir,
            maxUploadBytes: isText
              ? Math.min(deps.maxUploadBytes, MAX_TEXT_UPLOAD_BYTES)
              : deps.maxUploadBytes,
            maxPerUserBytes: deps.maxPerUserBytes,
          },
          {
            ownerUserId: drawing.userId,
            uploadedByUserId: req.user?.id ?? null,
            drawingId,
            kind: uploadPresentation.kind,
            originalName: name,
            mimeType:
              uploadPresentation.kind === "MARKDOWN"
                ? "text/markdown; charset=utf-8"
                : uploadPresentation.kind === "TEXT"
                  ? "text/plain; charset=utf-8"
                  : "application/pdf",
            source,
            // Only a PDF has anything to shrink; running the optimiser over
            // UTF-8 text would rewrite bytes the user uploaded verbatim.
            prepareStored: uploadPresentation.kind === "PDF" ? deps.optimizeUpload : undefined,
          },
        );

        let pageCount: number | null = null;
        try {
          if (uploadPresentation.kind === "PDF") {
            // The created row does not carry its blob, and describeUpload needs
            // to find the bytes on disk.
            ({ pageCount } = await deps.describeUpload({ ...created.asset, blob: created.blob }));
          } else {
            const sourceText = Buffer.concat(textChunks).toString("utf8");
            pageCount = paginateDocumentSource(sourceText, uploadPresentation.kind).length;
          }
          if (pageCount !== null) {
            await deps.prisma.asset.update({
              where: { id: created.asset.id },
              data: { pageCount },
            });
          }
        } catch (err) {
          // The bytes are stored but unusable. Say so and take them back out
          // rather than leaving a document that can never be opened.
          await deps.prisma.drawingAsset.deleteMany({ where: { assetId: created.asset.id } });
          await deps.prisma.asset.update({
            where: { id: created.asset.id },
            data: { status: "REJECTED", deleteAfter: new Date() },
          });
          if (err instanceof PdfRejectedError) {
            return res.status(422).json({ error: "Unreadable document", message: err.message });
          }
          throw err;
        }

        return res.status(201).json({
          id: created.asset.id,
          kind: uploadPresentation.kind,
          name: created.asset.originalName,
          sizeBytes: created.sizeBytes,
          pageCount,
          note: created.note,
        });
      } catch (err) {
        if (err instanceof InvalidTextDocumentError) {
          return res.status(422).json({ error: "Invalid text document", message: err.message });
        }
        if (err instanceof AssetTooLargeError) {
          return res.status(413).json({
            code: "asset-too-large",
            error: "File too large",
            message: err.message,
          });
        }
        if (err instanceof QuotaExceededError) {
          return res.status(507).json({ error: "Storage limit reached", message: err.message });
        }
        throw err;
      }
    }),
  );

  // Rename metadata only; the immutable bytes and their content hash do not change.
  app.patch(
    "/drawings/:drawingId/assets/:assetId",
    deps.requireAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const found = await authorizedAsset(deps, req);
      if (!found || !found.link) return res.status(404).json({ error: "Document not found" });
      if (!canEditDrawing(found.access)) {
        return res.status(403).json({
          error: "Read-only access",
          message: "You can view this board but not rename its documents.",
        });
      }

      const name = normalizedAssetName(req.body?.name);
      if (!name) {
        return res.status(400).json({
          error: "Invalid document name",
          message: `Use a filename between 1 and ${MAX_ASSET_NAME_LENGTH} characters.`,
        });
      }

      const asset = await deps.prisma.asset.update({
        where: { id: found.asset.id },
        data: { originalName: name },
      });
      res.setHeader("Cache-Control", "private, no-cache, must-revalidate");
      return res.json({
        id: asset.id,
        kind: asset.kind,
        name: asset.originalName,
        pageCount: asset.pageCount,
        sizeBytes: found.asset.blob?.sizeBytes ?? null,
      });
    }),
  );

  // Replace immutable Markdown bytes and atomically move every live widget
  // sharing this Asset to the replacement. The old Asset remains reachable
  // from the snapshot made below, so editing today cannot rewrite yesterday's
  // history or silently fork duplicated widgets.
  app.put(
    "/drawings/:drawingId/assets/:assetId/content",
    deps.requireAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const documentEditLocks = deps.documentEditLocks;
      if (!documentEditLocks) {
        return res.status(503).json({ error: "Markdown editing is unavailable" });
      }
      const found = await authorizedAsset(deps, req);
      if (!found?.link || found.link.state !== "ACTIVE" || found.asset.kind !== "MARKDOWN") {
        return res.status(404).json({ error: "Markdown document not found" });
      }
      if (!canEditDrawing(found.access)) {
        return res.status(403).json({
          error: "Read-only access",
          message: "You can view this board but not edit its Markdown files.",
        });
      }

      const elementId = typeof req.query.elementId === "string" ? req.query.elementId : "";
      if (!ID.test(elementId)) {
        return res.status(400).json({ error: "Invalid document widget" });
      }
      const expectedRevision = `"${found.asset.blob.sha256}"`;
      if (!req.headers["if-match"]) {
        return res.status(428).json({
          error: "Document revision required",
          code: "DOCUMENT_REVISION_REQUIRED",
        });
      }
      if (req.headers["if-match"] !== expectedRevision) {
        return res.status(409).json({
          error: "Document changed",
          code: "DOCUMENT_REVISION_CONFLICT",
          message: "This Markdown file changed after editing began. Your draft was not saved.",
        });
      }

      const editToken = String(req.headers["x-document-edit-token"] ?? "");
      const lock = documentEditLocks.validate(found.drawingId, found.asset.id, editToken);
      if (!lock) {
        return res.status(409).json({
          error: "Edit lock lost",
          code: "DOCUMENT_EDIT_LOCK_LOST",
          message:
            "The edit lock ended before this draft could be saved. Your draft is still open.",
        });
      }

      const before = await deps.prisma.drawing.findUnique({
        where: { id: found.drawingId },
        select: { elements: true, userId: true },
      });
      const beforeElements = before ? JSON.parse(before.elements) : null;
      if (
        !before ||
        !replaceMarkdownWidgetAsset(beforeElements, elementId, found.asset.id, found.asset.id)
      ) {
        return res.status(409).json({
          error: "Document changed",
          code: "DOCUMENT_WIDGET_CHANGED",
          message: "This widget now points to another file. Your draft was not saved.",
        });
      }

      const textChunks: Buffer[] = [];
      const source = Readable.from(
        (async function* () {
          for await (const chunk of validatedTextUpload(req)) {
            textChunks.push(chunk);
            yield chunk;
          }
        })(),
      );

      try {
        const created = await createAsset(
          {
            prisma: deps.prisma,
            storageDir: deps.storageDir,
            maxUploadBytes: Math.min(deps.maxUploadBytes, MAX_TEXT_UPLOAD_BYTES),
            maxPerUserBytes: deps.maxPerUserBytes,
          },
          {
            ownerUserId: before.userId,
            uploadedByUserId: req.user?.id ?? null,
            drawingId: found.drawingId,
            kind: "MARKDOWN",
            originalName: found.asset.originalName,
            mimeType: "text/markdown; charset=utf-8",
            source,
          },
        );
        const content = Buffer.concat(textChunks).toString("utf8");
        const pageCount = paginateDocumentSource(content, "MARKDOWN").length;
        await deps.prisma.asset.update({
          where: { id: created.asset.id },
          data: { pageCount },
        });

        if (!documentEditLocks.validate(found.drawingId, found.asset.id, editToken)) {
          return res.status(409).json({
            error: "Edit lock lost",
            code: "DOCUMENT_EDIT_LOCK_LOST",
            message:
              "The edit lock ended before this draft could be saved. Your draft is still open.",
          });
        }

        const updated = await deps.prisma.$transaction(
          async (tx: any) => {
            const drawing = await tx.drawing.findUnique({ where: { id: found.drawingId } });
            if (!drawing) throw new Error("DOCUMENT_WIDGET_CHANGED");
            const currentElements = JSON.parse(drawing.elements);
            const replacement = replaceMarkdownWidgetAsset(
              currentElements,
              elementId,
              found.asset.id,
              created.asset.id,
            );
            if (!replacement) throw new Error("DOCUMENT_WIDGET_CHANGED");
            const nextElements = replacement.elements;

            const snapshot = await tx.drawingSnapshot.create({
              data: {
                drawingId: found.drawingId,
                version: drawing.version,
                elements: encodeSnapshotField(drawing.elements, config.enableSnapshotCompression),
                appState: encodeSnapshotField(drawing.appState, config.enableSnapshotCompression),
                files: encodeSnapshotField(drawing.files, config.enableSnapshotCompression),
              },
            });
            await captureSnapshotAssets(tx, snapshot.id, found.drawingId);

            const result = await tx.drawing.updateMany({
              where: { id: found.drawingId, version: drawing.version },
              data: { elements: JSON.stringify(nextElements), version: { increment: 1 } },
            });
            if (result.count !== 1) throw new Error("DOCUMENT_VERSION_CONFLICT");
            await syncDrawingDocumentState(tx, found.drawingId, nextElements, {
              correlationId: requestIdOf(req),
            });
            await pruneDrawingSnapshots(tx, found.drawingId, config.snapshotMaxCountPerDrawing);
            return {
              drawing: await tx.drawing.findUniqueOrThrow({ where: { id: found.drawingId } }),
              elements: replacement.replacedElements,
            };
          },
          { timeout: 15_000 },
        );

        const released = documentEditLocks.releaseToken(found.drawingId, found.asset.id, editToken);
        deps.invalidateDrawingsCache?.();
        if (deps.io) {
          const room = deps.io.to(`drawing_${found.drawingId}`);
          const peers = released ? room.except(released.presenceId) : room;
          peers.emit("document-asset-replaced", {
            drawingId: found.drawingId,
            previousAssetId: found.asset.id,
            assetId: created.asset.id,
            drawingVersion: updated.drawing.version,
            elements: updated.elements,
          });
          deps.io
            .to(`drawing_${found.drawingId}`)
            .emit(
              DOCUMENT_EDIT_LOCK_EVENT,
              documentEditLockSnapshot(documentEditLocks, found.drawingId),
            );
        }

        res.setHeader("Cache-Control", "private, no-cache, must-revalidate");
        return res.json({
          id: created.asset.id,
          kind: "MARKDOWN",
          name: created.asset.originalName,
          sizeBytes: created.sizeBytes,
          pageCount,
          revision: created.blob.sha256,
          drawingVersion: updated.drawing.version,
          elements: updated.elements,
        });
      } catch (err) {
        if (err instanceof InvalidTextDocumentError) {
          return res.status(422).json({ error: "Invalid text document", message: err.message });
        }
        if (err instanceof AssetTooLargeError) {
          return res.status(413).json({ error: "File too large", message: err.message });
        }
        if (err instanceof QuotaExceededError) {
          return res.status(507).json({ error: "Storage limit reached", message: err.message });
        }
        if (err instanceof Error && err.message.startsWith("DOCUMENT_")) {
          return res.status(409).json({
            error: "Document changed",
            code: err.message,
            message:
              "The board changed while this draft was being saved. Your draft is still open.",
          });
        }
        throw err;
      }
    }),
  );

  // Served as source bytes; the widget renders Markdown as React elements.
  app.get(
    "/drawings/:drawingId/assets/:assetId/content",
    deps.optionalAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const found = await authorizedAsset(deps, req);
      if (!found?.asset.blob || !["MARKDOWN", "TEXT"].includes(found.asset.kind)) {
        return res.status(404).json({ error: "Document not found" });
      }

      const { blob } = found.asset;
      res.setHeader("Content-Type", found.asset.mimeType);
      res.setHeader("Content-Disposition", contentDisposition("inline", found.asset.originalName));
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      res.setHeader("Cache-Control", "private, no-cache, must-revalidate");
      res.setHeader("Vary", "Cookie, Authorization");
      res.setHeader("ETag", `"${blob.sha256}"`);
      if (blob.contentEncoding) res.setHeader("Content-Encoding", blob.contentEncoding);

      if (req.headers["if-none-match"] === `"${blob.sha256}"`) return res.status(304).end();
      return streamStoredFile(res, resolveStoragePath(deps.storageDir, blob.storageKey));
    }),
  );

  // What the widget needs to draw itself. Deliberately not the storage key.
  app.get(
    "/drawings/:drawingId/assets/:assetId",
    deps.optionalAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const found = await authorizedAsset(deps, req);
      if (!found) return res.status(404).json({ error: "Document not found" });

      res.setHeader("Cache-Control", "private, no-cache, must-revalidate");
      return res.json({
        id: found.asset.id,
        kind: found.asset.kind,
        name: found.asset.originalName,
        pageCount: found.asset.pageCount,
        sizeBytes: found.asset.blob?.sizeBytes ?? null,
        revision: found.asset.blob?.sha256 ?? null,
      });
    }),
  );

  // The original, always as a download. Never rendered in place: whatever a
  // browser decides to do with a foreign file, it should not do it on our origin.
  app.get(
    "/drawings/:drawingId/assets/:assetId/original",
    deps.optionalAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const found = await authorizedAsset(deps, req);
      if (!found?.asset.blob) return res.status(404).json({ error: "Document not found" });

      const { blob } = found.asset;
      res.setHeader("Content-Type", found.asset.mimeType);
      res.setHeader(
        "Content-Disposition",
        contentDisposition("attachment", found.asset.originalName),
      );
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      res.setHeader("Cache-Control", "private, no-cache, must-revalidate");
      res.setHeader("Vary", "Cookie, Authorization");
      res.setHeader("ETag", `"${blob.sha256}"`);
      if (blob.contentEncoding) res.setHeader("Content-Encoding", blob.contentEncoding);

      if (req.headers["if-none-match"] === `"${blob.sha256}"`) return res.status(304).end();

      return streamStoredFile(res, resolveStoragePath(deps.storageDir, blob.storageKey));
    }),
  );

  // One rendered page.
  app.get(
    "/drawings/:drawingId/assets/:assetId/pages/:page",
    deps.optionalAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const found = await authorizedAsset(deps, req);
      if (!found) return res.status(404).json({ error: "Document not found" });
      // Only a PDF has anything for the renderer to produce. TEXT and
      // MARKDOWN documents keep a pageCount for their own widget pagination
      // (see socketDocumentPages.ts), but that number does not mean there is
      // a rendered image behind it.
      if (found.asset.kind !== "PDF") return res.status(404).json({ error: "Document not found" });

      const page = Number(req.params.page);
      const total = found.asset.pageCount ?? 0;
      if (!Number.isInteger(page) || page < 1 || page > total) {
        return res.status(404).json({
          error: "No such page",
          message: `This document has ${total} page${total === 1 ? "" : "s"}.`,
        });
      }

      try {
        const controller = new AbortController();
        const abort = () => controller.abort();
        req.once("aborted", abort);
        res.once("close", abort);
        let rendered;
        try {
          rendered = await deps.getPage(found.asset, page, controller.signal);
        } finally {
          req.off("aborted", abort);
          res.off("close", abort);
        }
        res.setHeader("Content-Type", rendered.mimeType);
        res.setHeader("Content-Disposition", contentDisposition("inline", `page-${page}`));
        res.setHeader("X-Content-Type-Options", "nosniff");
        // A page is drawn inside an <img>, where nothing can run. This says so
        // to the browser as well rather than relying on that alone.
        res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
        res.setHeader("Cache-Control", "private, no-cache, must-revalidate");
        res.setHeader("Vary", "Cookie, Authorization");
        if (rendered.contentEncoding) res.setHeader("Content-Encoding", rendered.contentEncoding);
        return res.send(rendered.body);
      } catch (err) {
        if (err instanceof QueueAbortedError) return;
        if (err instanceof QueueCapacityError) {
          return res.status(503).json({
            error: "Renderer busy",
            message: "Too many document pages are waiting to render. Try again shortly.",
          });
        }
        if (err instanceof PdfRejectedError) {
          return res.status(422).json({ error: "Page unavailable", message: err.message });
        }
        throw err;
      }
    }),
  );

  // How much room is left, so the interface can say so before someone waits
  // for a 30 MB upload only to be told no.
  app.get(
    "/assets/usage",
    deps.requireAuth,
    asyncHandler(async (req: Request, res: Response) => {
      const used = await usedBytesFor(deps.prisma, req.user!.id);
      return res.json({ usedBytes: used, limitBytes: deps.maxPerUserBytes });
    }),
  );
}
