import express from "express";
import { z } from "zod";
import {
  canEditDrawing,
  canViewDrawing,
  getDrawingAccess,
  isOwnerAccess,
} from "../../authz/sharing";
import {
  acquireContextLease,
  ContextLeaseHeldError,
  ContextLeaseNotHeldError,
  ContextLeaseTransferDeniedError,
  releaseContextLease,
  renewContextLease,
  transferContextLease,
} from "../../agent/contextLease";
import type { DrawingRouteContext } from "./drawingRouteContext";

const MAX_TTL_MS = 10 * 60_000;

const acquireSchema = z.object({
  holderOrchestratorId: z.string().min(1).max(200),
  runId: z.string().min(1).max(200),
  ttlMs: z.number().int().positive().max(MAX_TTL_MS),
  endHorizonAt: z.string().datetime(),
});
const renewSchema = z.object({
  leaseGeneration: z.string().min(1).max(200),
  runId: z.string().min(1).max(200),
  ttlMs: z.number().int().positive().max(MAX_TTL_MS),
});
const transferSchema = z.object({
  leaseGeneration: z.string().min(1).max(200),
  fromRunId: z.string().min(1).max(200),
  toOrchestratorId: z.string().min(1).max(200),
  toRunId: z.string().min(1).max(200),
  ttlMs: z.number().int().positive().max(MAX_TTL_MS),
  // A caller may only ASK for the override; whether it is actually granted
  // is decided below from the authenticated principal's own access, never
  // trusted from the request body.
  requestOverride: z.boolean().optional(),
});
const releaseSchema = z.object({
  leaseGeneration: z.string().min(1).max(200),
  runId: z.string().min(1).max(200),
});

const leaseErrorResponse = (res: express.Response, error: unknown): boolean => {
  if (error instanceof ContextLeaseHeldError) {
    res.status(409).json({
      error: "Context busy",
      code: "CONTEXT_LEASE_HELD",
      message: error.message,
      heldBy: {
        holderOrchestratorId: error.heldBy.holderOrchestratorId,
        runId: error.heldBy.runId,
        expiresAt: error.heldBy.expiresAt.toISOString(),
      },
    });
    return true;
  }
  if (error instanceof ContextLeaseTransferDeniedError) {
    res
      .status(403)
      .json({ error: "Forbidden", code: "CONTEXT_LEASE_TRANSFER_DENIED", message: error.message });
    return true;
  }
  if (error instanceof ContextLeaseNotHeldError) {
    res
      .status(409)
      .json({ error: "Lease conflict", code: "CONTEXT_LEASE_NOT_HELD", message: error.message });
    return true;
  }
  return false;
};

const snapshotJson = (lease: {
  contextId: string;
  leaseGeneration: string;
  holderOrchestratorId: string;
  initiatedByUserId: string;
  runId: string;
  acquiredAt: Date;
  expiresAt: Date;
  endHorizonAt: Date;
}) => ({
  contextId: lease.contextId,
  leaseGeneration: lease.leaseGeneration,
  holderOrchestratorId: lease.holderOrchestratorId,
  initiatedByUserId: lease.initiatedByUserId,
  runId: lease.runId,
  acquiredAt: lease.acquiredAt.toISOString(),
  expiresAt: lease.expiresAt.toISOString(),
  endHorizonAt: lease.endHorizonAt.toISOString(),
});

/**
 * NIL-680. This is the ONLY write surface for a Context's public-effect
 * exclusivity -- every field that decides authority (`initiatedByUserId`,
 * override eligibility) comes from the authenticated principal, never from
 * the request body, the same boundary `elementGuestProvenanceRoutes.ts`
 * draws for its own approval seam.
 */
export const registerDrawingLeaseRoutes = (app: express.Express, context: DrawingRouteContext) => {
  const {
    optionalAuth,
    asyncHandler,
    getRequestPrincipal,
    getShareToken,
    respondWithAuthErrorIfPresent,
    prisma,
  } = context;

  const load = async (req: express.Request, res: express.Response, edit: boolean) => {
    const principal = await getRequestPrincipal(req);
    const access = await getDrawingAccess({
      prisma,
      principal,
      drawingId: req.params.id,
      shareToken: getShareToken(req),
    });
    if (!(edit ? canEditDrawing(access) : canViewDrawing(access))) {
      if (respondWithAuthErrorIfPresent(req, res)) return null;
      res.status(404).json({ error: "Drawing not found", message: "Drawing does not exist" });
      return null;
    }
    if (!req.user?.id || req.user.authCredentialType === "apiKey") {
      res.status(401).json({ error: "Sign in required" });
      return null;
    }
    const contextRow = await prisma.agentContext.findFirst({
      where: { id: req.params.contextId, drawingId: req.params.id },
      select: { id: true },
    });
    if (!contextRow) {
      res.status(404).json({ error: "Agent Context not found" });
      return null;
    }
    return { userId: req.user.id as string, isOwner: isOwnerAccess(access) };
  };

  app.get(
    "/drawings/:id/agent/contexts/:contextId/lease",
    optionalAuth,
    asyncHandler(async (req, res) => {
      if (!(await load(req, res, false))) return;
      const lease = await prisma.contextLease.findUnique({
        where: { contextId: req.params.contextId },
      });
      if (!lease || lease.releasedAt || lease.expiresAt.getTime() < Date.now()) {
        return res.json({ lease: null });
      }
      return res.json({ lease: snapshotJson(lease) });
    }),
  );

  app.post(
    "/drawings/:id/agent/contexts/:contextId/lease/acquire",
    optionalAuth,
    asyncHandler(async (req, res) => {
      const loaded = await load(req, res, true);
      if (!loaded) return;
      const parsed = acquireSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "Validation error", message: "Invalid lease request" });
      }
      try {
        const lease = await acquireContextLease({
          prisma,
          contextId: req.params.contextId,
          holderOrchestratorId: parsed.data.holderOrchestratorId,
          initiatedByUserId: loaded.userId,
          runId: parsed.data.runId,
          ttlMs: parsed.data.ttlMs,
          endHorizonAt: new Date(parsed.data.endHorizonAt),
        });
        return res.status(201).json({ lease: snapshotJson(lease) });
      } catch (error) {
        if (leaseErrorResponse(res, error)) return;
        throw error;
      }
    }),
  );

  app.post(
    "/drawings/:id/agent/contexts/:contextId/lease/renew",
    optionalAuth,
    asyncHandler(async (req, res) => {
      if (!(await load(req, res, true))) return;
      const parsed = renewSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "Validation error", message: "Invalid renew request" });
      }
      try {
        const lease = await renewContextLease({
          prisma,
          contextId: req.params.contextId,
          leaseGeneration: parsed.data.leaseGeneration,
          runId: parsed.data.runId,
          ttlMs: parsed.data.ttlMs,
        });
        return res.json({ lease: snapshotJson(lease) });
      } catch (error) {
        if (leaseErrorResponse(res, error)) return;
        throw error;
      }
    }),
  );

  app.post(
    "/drawings/:id/agent/contexts/:contextId/lease/transfer",
    optionalAuth,
    asyncHandler(async (req, res) => {
      const loaded = await load(req, res, true);
      if (!loaded) return;
      const parsed = transferSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "Validation error", message: "Invalid transfer request" });
      }
      try {
        const lease = await transferContextLease({
          prisma,
          contextId: req.params.contextId,
          leaseGeneration: parsed.data.leaseGeneration,
          fromRunId: parsed.data.fromRunId,
          toOrchestratorId: parsed.data.toOrchestratorId,
          toRunId: parsed.data.toRunId,
          toInitiatedByUserId: loaded.userId,
          // Only the board owner's own authenticated request may exercise
          // an override; the client-requested flag never grants it alone.
          authorizedAsOverride: Boolean(parsed.data.requestOverride) && loaded.isOwner,
          ttlMs: parsed.data.ttlMs,
        });
        return res.json({ lease: snapshotJson(lease) });
      } catch (error) {
        if (leaseErrorResponse(res, error)) return;
        throw error;
      }
    }),
  );

  app.post(
    "/drawings/:id/agent/contexts/:contextId/lease/release",
    optionalAuth,
    asyncHandler(async (req, res) => {
      if (!(await load(req, res, true))) return;
      const parsed = releaseSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "Validation error", message: "Invalid release request" });
      }
      try {
        await releaseContextLease({
          prisma,
          contextId: req.params.contextId,
          leaseGeneration: parsed.data.leaseGeneration,
          runId: parsed.data.runId,
        });
        return res.status(204).send();
      } catch (error) {
        if (leaseErrorResponse(res, error)) return;
        throw error;
      }
    }),
  );
};
