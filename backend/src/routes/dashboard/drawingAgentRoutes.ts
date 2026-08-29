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
import { requestIdOf } from "../../middleware/requestId";
import { computeSearchText } from "../../search/searchIndex";
import type { DrawingRouteContext } from "./drawingRouteContext";
import {
  AgentMountError,
  createAgentRunMount,
  executeAgentBoardTool,
  isAgentToolName,
} from "../../agent/boardMount";
import { AgentContextAuthorizationError } from "../../authz/agentContext";
import {
  AgentContextValidationError,
  assertPersistedAgentContextFrames,
} from "../../agent/boardContexts";

/**
 * The exclusive route surface a drawing-bound agent token (NIL-382) may
 * reach: the immutable mount/tool surface and `POST .../agent/ops`.
 * `middleware/auth.ts#getAgentRouteDrawingId` names these same paths -- if
 * this file's routes and that allow-list ever
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

  const respondWithMountError = (res: express.Response, error: unknown): boolean => {
    if (error instanceof AgentContextAuthorizationError) {
      res.status(403).json({ error: "Forbidden", code: error.code, message: error.message });
      return true;
    }
    if (error instanceof AgentContextValidationError) {
      res
        .status(409)
        .json({ error: "Invalid Context map", code: error.code, message: error.message });
      return true;
    }
    if (error instanceof AgentMountError) {
      if (["MOUNT_NOT_FOUND", "INVALID_MOUNT_TOKEN"].includes(error.code)) {
        res.status(404).json({
          error: "Agent mount error",
          code: "MOUNT_NOT_FOUND",
          message: "Run mount is not available.",
        });
        return true;
      }
      const status = error.code === "ASSET_TOO_LARGE" ? 413 : 400;
      res
        .status(status)
        .json({ error: "Agent mount error", code: error.code, message: error.message });
      return true;
    }
    return false;
  };

  // A mount is the only read entry point. It captures one immutable scene and
  // returns a second, run-bound capability credential; there is deliberately
  // no full-scene GET and no mutable summary/elements compatibility path.
  app.post(
    "/drawings/:id/agent/mounts",
    optionalAuth,
    asyncHandler(async (req, res) => {
      const loaded = await loadAccessibleDrawing(req, res, false);
      if (!loaded) return;
      // The agent may consume a scope but must never choose or widen it. A
      // human/controller credential creates the mount and hands the opaque
      // capability to the already board-bound agent token.
      if (req.user?.authCredentialType === "apiKey") {
        return res.status(403).json({
          error: "Forbidden",
          code: "MOUNT_ISSUER_REQUIRED",
          message: "An agent token cannot issue its own run mount.",
        });
      }
      const body =
        req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
      if (
        (body.runId !== undefined &&
          (typeof body.runId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.runId))) ||
        (body.allowedContextIds !== undefined &&
          (!Array.isArray(body.allowedContextIds) ||
            body.allowedContextIds.length > 100 ||
            body.allowedContextIds.some((id: unknown) => typeof id !== "string"))) ||
        (body.capabilities !== undefined &&
          (!Array.isArray(body.capabilities) ||
            body.capabilities.length > 10 ||
            body.capabilities.some((capability: unknown) => typeof capability !== "string")))
      ) {
        return res.status(400).json({ error: "Invalid mount request" });
      }
      try {
        const mount = await createAgentRunMount({
          prisma,
          drawingId: loaded.id,
          runId: body.runId,
          allowedContextIds: body.allowedContextIds,
          capabilities: body.capabilities,
        });
        return res.status(201).json(mount);
      } catch (error: any) {
        if (error?.code === "P2002") {
          return res
            .status(409)
            .json({ error: "Run id already mounted", code: "RUN_ALREADY_MOUNTED" });
        }
        if (respondWithMountError(res, error)) return;
        throw error;
      }
    }),
  );

  app.post(
    "/drawings/:id/agent/mounts/:runId/tools/:tool",
    optionalAuth,
    asyncHandler(async (req, res) => {
      const loaded = await loadAccessibleDrawing(req, res, false);
      if (!loaded) return;
      const capabilityToken = req.header("x-agent-mount-token");
      if (!capabilityToken || capabilityToken.length > 256 || !isAgentToolName(req.params.tool)) {
        return res.status(400).json({ error: "Invalid tool request" });
      }
      const args =
        req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
      try {
        return res.json(
          await executeAgentBoardTool({
            prisma,
            drawingId: loaded.id,
            runId: req.params.runId,
            capabilityToken,
            tool: req.params.tool,
            args,
          }),
        );
      } catch (error) {
        if (respondWithMountError(res, error)) return;
        throw error;
      }
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
          await assertPersistedAgentContextFrames(tx, id, newElements);
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
            correlationId: requestIdOf(req),
          });
          await pruneDrawingSnapshots(tx, id, config.snapshotMaxCountPerDrawing);

          return tx.drawing.findFirst({ where: { id } });
        });
      } catch (error) {
        if (respondWithMountError(res, error)) return;
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
