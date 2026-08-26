import express from "express";
import { canEditDrawing, canViewDrawing, getDrawingAccess } from "../../authz/sharing";
import { opsBatchSchema } from "../../agent/opSchemas";
import { applyOperations } from "../../agent/applyOps";
import { encodeSnapshotField } from "../../snapshots/snapshotCodec";
import { captureSnapshotAssets } from "../../assets/assetService";
import {
  InvalidDocumentWidgetStateError,
  syncDrawingDocumentState,
} from "../../assets/documentWidgetState";
import { pruneDrawingSnapshots } from "../../snapshots/snapshotRetention";
import { computeSearchText } from "../../search/searchIndex";
import type { DrawingRouteContext } from "./drawingRouteContext";

/**
 * The exclusive route surface a drawing-bound agent token (NIL-382) may
 * reach: `GET .../agent/summary`, `GET .../agent/elements`,
 * `POST .../agent/ops`. `middleware/auth.ts#getAgentRouteDrawingId` names
 * these same three paths -- if this file's routes and that allow-list ever
 * disagree, either an agent token gets a 403 for a route it should reach, or
 * (the direction that matters) a route reachable by an agent token exists
 * that the allow-list never had to name. Every route here still re-checks
 * board access itself (`getDrawingAccess`/`canEditDrawing`) rather than
 * trusting `req.apiKeyDrawingId`: a human JWT session can reach these routes
 * too, and an agent token's board access can be revoked after the token was
 * minted -- the auth-layer route restriction and this authz-layer access
 * check are two different questions, not one checked twice.
 */
export const registerDrawingAgentRoutes = (app: express.Express, context: DrawingRouteContext) => {
  const {
    prisma,
    optionalAuth,
    asyncHandler,
    parseJsonField,
    getRequestPrincipal,
    getShareToken,
    respondWithAuthErrorIfPresent,
    respondWithValidationErrors,
    invalidateDrawingsCache,
    config,
    io,
  } = context;

  const loadAccessibleDrawing = async (
    req: express.Request,
    res: express.Response,
    requireEdit: boolean,
  ): Promise<{ id: string } | null> => {
    const principal = await getRequestPrincipal(req);
    const { id } = req.params;
    const access = await getDrawingAccess({
      prisma,
      principal,
      drawingId: id,
      shareToken: getShareToken(req),
    });
    const allowed = requireEdit ? canEditDrawing(access) : canViewDrawing(access);
    if (!allowed) {
      if (respondWithAuthErrorIfPresent(req, res)) return null;
      res.status(404).json({ error: "Drawing not found", message: "Drawing does not exist" });
      return null;
    }
    return { id };
  };

  // ------------------------------------------------------------------
  // GET /drawings/:id/agent/summary
  // A compact scene summary -- element count by type, not the raw scene --
  // so an agent tool loop can decide its next move without pulling the whole
  // board (potentially megabytes of geometry) on every turn.
  // ------------------------------------------------------------------
  app.get(
    "/drawings/:id/agent/summary",
    optionalAuth,
    asyncHandler(async (req, res) => {
      const loaded = await loadAccessibleDrawing(req, res, false);
      if (!loaded) return;

      const drawing = await prisma.drawing.findUnique({
        where: { id: loaded.id },
        select: { version: true, elements: true },
      });
      if (!drawing) return res.status(404).json({ error: "Drawing not found" });

      const elements = parseJsonField(drawing.elements, []) as Array<Record<string, unknown>>;
      const elementCountsByType: Record<string, number> = {};
      let elementCount = 0;
      for (const element of elements) {
        if (element?.isDeleted) continue;
        elementCount += 1;
        const type = typeof element?.type === "string" ? element.type : "unknown";
        elementCountsByType[type] = (elementCountsByType[type] ?? 0) + 1;
      }

      return res.json({ version: drawing.version, elementCount, elementCountsByType });
    }),
  );

  // ------------------------------------------------------------------
  // GET /drawings/:id/agent/elements
  // The full element list, lossless -- for when the agent needs exact
  // geometry, not just counts.
  // ------------------------------------------------------------------
  app.get(
    "/drawings/:id/agent/elements",
    optionalAuth,
    asyncHandler(async (req, res) => {
      const loaded = await loadAccessibleDrawing(req, res, false);
      if (!loaded) return;

      const drawing = await prisma.drawing.findUnique({
        where: { id: loaded.id },
        select: { version: true, elements: true },
      });
      if (!drawing) return res.status(404).json({ error: "Drawing not found" });

      return res.json({ version: drawing.version, elements: parseJsonField(drawing.elements, []) });
    }),
  );

  // ------------------------------------------------------------------
  // POST /drawings/:id/agent/ops
  // The narrow semantic operations API (opSchemas.ts/applyOps.ts): Zod-
  // validated, capped at MAX_OPS_PER_BATCH, ids/versions server-assigned,
  // and the whole batch is validated against the current scene in memory
  // BEFORE any database write -- so "the whole batch is discarded on any
  // error" falls out of ordering, not a rollback.
  // ------------------------------------------------------------------
  app.post(
    "/drawings/:id/agent/ops",
    optionalAuth,
    asyncHandler(async (req, res) => {
      const loaded = await loadAccessibleDrawing(req, res, true);
      if (!loaded) return;
      const { id } = loaded;

      const parsed = opsBatchSchema.safeParse(req.body);
      if (!parsed.success) {
        return respondWithValidationErrors(res, parsed.error.issues);
      }

      const existingDrawing = await prisma.drawing.findUnique({ where: { id } });
      if (!existingDrawing) return res.status(404).json({ error: "Drawing not found" });

      if (parsed.data.version !== existingDrawing.version) {
        return res.status(409).json({
          error: "Conflict",
          code: "VERSION_CONFLICT",
          message: "Drawing has changed since this batch was computed.",
          currentVersion: existingDrawing.version,
        });
      }

      const currentElements = parseJsonField(existingDrawing.elements, []) as unknown[];
      const result = applyOperations(currentElements, parsed.data.ops);
      if (!result.ok || !result.elements) {
        return res.status(400).json({ error: "Invalid operation", message: result.error });
      }
      const newElements = result.elements;

      const versionConflictError = new Error("VERSION_CONFLICT");
      let updatedDrawing: typeof existingDrawing | null = null;

      try {
        updatedDrawing = await prisma.$transaction(async (tx) => {
          const compress = config.enableSnapshotCompression;
          const snapshot = await tx.drawingSnapshot.create({
            data: {
              drawingId: id,
              version: existingDrawing.version,
              elements: encodeSnapshotField(existingDrawing.elements, compress),
              appState: encodeSnapshotField(existingDrawing.appState, compress),
              files: encodeSnapshotField(existingDrawing.files, compress),
            },
          });

          const updateResult = await tx.drawing.updateMany({
            where: { id, version: existingDrawing.version },
            data: {
              elements: JSON.stringify(newElements),
              version: { increment: 1 },
              searchText: computeSearchText(existingDrawing.name, newElements),
            },
          });
          if (updateResult.count === 0) {
            throw versionConflictError;
          }

          await captureSnapshotAssets(tx, snapshot.id, id);
          await syncDrawingDocumentState(tx, id, newElements, {
            correlationId: req.headers["x-request-id"] as string | undefined,
          });
          await pruneDrawingSnapshots(tx, id, config.snapshotMaxCountPerDrawing);

          return tx.drawing.findFirst({ where: { id } });
        });
      } catch (error) {
        if (error instanceof InvalidDocumentWidgetStateError) {
          return res.status(400).json({
            error: "Invalid document widgets",
            code: error.code,
            message: error.message,
          });
        }
        if (
          error === versionConflictError ||
          (error instanceof Error && error.message === versionConflictError.message)
        ) {
          const latestDrawing = await prisma.drawing.findFirst({
            where: { id },
            select: { version: true },
          });
          return res.status(409).json({
            error: "Conflict",
            code: "VERSION_CONFLICT",
            message: "Drawing has changed since this batch was computed.",
            currentVersion: latestDrawing?.version ?? null,
          });
        }
        throw error;
      }
      if (!updatedDrawing) {
        return res.status(404).json({ error: "Drawing not found" });
      }

      invalidateDrawingsCache();
      io.to(`drawing_${id}`).emit("drawing-server-update", { drawingId: id });

      return res.json({
        version: updatedDrawing.version,
        elements: parseJsonField(updatedDrawing.elements, []),
      });
    }),
  );
};
