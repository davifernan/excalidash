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
  toOrchestratorId: z.string().min(1).max(200),
  toRunId: z.string().min(1).max(200),
  ttlMs: z.number().int().positive().max(MAX_TTL_MS),
  // A caller may only ASK for the override; whether it is actually granted
  // is decided below from the authenticated principal's own access, never
  // trusted from the request body. Consent from the actual current holder
  // is decided server-side too -- from the authenticated caller's user id
  // against the lease's own `initiatedByUserId`, never from a client-sent
  // "I am the holder" claim.
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
      // Deliberately no `runId`: it would double as a bearer credential for
      // the very release/renew/transfer calls this file gates on identity,
      // not on knowing an identifier that leaked through a busy response.
      heldBy: {
        holderOrchestratorId: error.heldBy.holderOrchestratorId,
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

type LeaseRow = {
  contextId: string;
  leaseGeneration: string;
  holderOrchestratorId: string;
  initiatedByUserId: string;
  runId: string;
  acquiredAt: Date;
  expiresAt: Date;
  endHorizonAt: Date;
};

/**
 * `leaseGeneration` and `runId` are the compare keys renew/transfer/release
 * take back from a caller -- but `contextLease.ts`'s own CAS now folds
 * caller identity into the WHERE clause too, so knowing them is no longer
 * sufficient to act on someone else's lease. They are still not hidden from
 * every viewer for free: only the lease's own initiator, or the board
 * owner, gets the full shape. Anyone else with mere view access sees only
 * that the Context is held, by whom (a display label, not a credential),
 * and when it frees up.
 */
const leaseJson = (lease: LeaseRow, viewer: { userId: string; isOwner: boolean }) => {
  const isPrivileged = viewer.isOwner || lease.initiatedByUserId === viewer.userId;
  const base = {
    contextId: lease.contextId,
    holderOrchestratorId: lease.holderOrchestratorId,
    acquiredAt: lease.acquiredAt.toISOString(),
    expiresAt: lease.expiresAt.toISOString(),
    endHorizonAt: lease.endHorizonAt.toISOString(),
  };
  if (!isPrivileged) return base;
  return {
    ...base,
    leaseGeneration: lease.leaseGeneration,
    initiatedByUserId: lease.initiatedByUserId,
    runId: lease.runId,
  };
};

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
      const loaded = await load(req, res, false);
      if (!loaded) return;
      const lease = await prisma.contextLease.findUnique({
        where: { contextId: req.params.contextId },
      });
      if (!lease || lease.releasedAt || lease.expiresAt.getTime() < Date.now()) {
        return res.json({ lease: null });
      }
      return res.json({ lease: leaseJson(lease, loaded) });
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
        return res.status(201).json({ lease: leaseJson(lease, loaded) });
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
      const loaded = await load(req, res, true);
      if (!loaded) return;
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
          callerUserId: loaded.userId,
          allowOwnerOverride: loaded.isOwner,
          ttlMs: parsed.data.ttlMs,
        });
        return res.json({ lease: leaseJson(lease, loaded) });
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
          callerUserId: loaded.userId,
          toOrchestratorId: parsed.data.toOrchestratorId,
          toRunId: parsed.data.toRunId,
          toInitiatedByUserId: loaded.userId,
          // Only the board owner's own authenticated request may exercise
          // an override; the client-requested flag never grants it alone.
          authorizedAsOverride: Boolean(parsed.data.requestOverride) && loaded.isOwner,
          ttlMs: parsed.data.ttlMs,
        });
        return res.json({ lease: leaseJson(lease, loaded) });
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
      const loaded = await load(req, res, true);
      if (!loaded) return;
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
          callerUserId: loaded.userId,
          allowOwnerOverride: loaded.isOwner,
        });
        return res.status(204).send();
      } catch (error) {
        if (leaseErrorResponse(res, error)) return;
        throw error;
      }
    }),
  );
};
