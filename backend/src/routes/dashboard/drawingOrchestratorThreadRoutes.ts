import crypto from "node:crypto";
import express from "express";
import { z } from "zod";
import {
  canEditDrawing,
  canViewDrawing,
  getDrawingAccess,
  type DrawingAccess,
} from "../../authz/sharing";
import { AGENT_RUNTIME_CAPABILITIES, AgentRuntimeError } from "../../agent/runtime/contracts";
import { createAgentRunMount } from "../../agent/boardMount";
import {
  acquireContextLease,
  ContextLeaseHeldError,
  releaseContextLease,
} from "../../agent/contextLease";
import {
  acceptDispatchReceipt,
  DispatchReceiptError,
  listPublicDispatchReceipts,
  listUnresolvedDispatchReceipts,
  reconcileDispatchReceipt,
} from "../../agent/dispatchReceipt";
import { processDispatchOutbox, reportDispatchBackgroundFailure } from "../../agent/dispatchWorker";
import {
  OrchestratorThreadError,
  appendOrchestratorThreadMessage,
  getOrCreatePrivateOrchestratorThread,
  getVisibleOrchestratorThread,
  listOrchestratorThreadEvents,
  listVisibleOrchestratorThreads,
  movePrivateOrchestratorThread,
  registerDrawingOrchestratorThread,
} from "../../agent/orchestratorThreads";
import {
  publishBoardAgentThreadEvent,
  publishBoardAgentThreadUpdated,
} from "../../server/socketAgentThreads";
import { publishBoardAgentDispatchReceipt } from "../../server/socketDispatchReceipts";
import type { DrawingRouteContext } from "./drawingRouteContext";

const coordinate = z.number().finite().min(-10_000_000).max(10_000_000);
const anchorSchema = z.object({ x: coordinate, y: coordinate });
const sharedSchema = z.object({ anchorElementId: z.string().min(1).max(200) });
const messageSchema = z.object({ text: z.string().trim().min(1).max(10_000) });
const MAX_PUBLIC_DISPATCH_MS = 10 * 60_000;
const dispatchSchema = z
  .object({
    publicThreadId: z.string().uuid(),
    objectiveSummary: z.string().trim().min(1).max(2_000),
    targetContextIds: z.array(z.string().uuid()).min(1).max(10),
    requestedCapabilities: z.array(z.enum(AGENT_RUNTIME_CAPABILITIES)).min(1).max(8),
    budget: z.object({ maxRuntimeMs: z.number().int().positive().max(MAX_PUBLIC_DISPATCH_MS) }),
    expectedArtifacts: z.array(z.string().trim().min(1).max(200)).max(20),
    connectionId: z.string().min(1).max(128),
    profileId: z.string().min(1).max(128),
    displayName: z.string().trim().min(1).max(80),
    approval: z.object({ publicEffect: z.literal(true), fanout: z.boolean().optional() }),
  })
  .superRefine((value, ctx) => {
    if (value.targetContextIds.length > 1 && value.approval.fanout !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approval", "fanout"],
        message: "Multiple public targets require an explicit fan-out approval.",
      });
    }
    if (
      !value.requestedCapabilities.includes("agent:run") ||
      !value.requestedCapabilities.some((capability) =>
        ["board:write", "artifact:publish"].includes(capability),
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requestedCapabilities"],
        message: "A public-effect dispatch must request agent:run and a public effect capability.",
      });
    }
  });

const handleThreadError = (res: express.Response, error: unknown): boolean => {
  if (!(error instanceof OrchestratorThreadError)) return false;
  const status = error.code === "THREAD_INVALID" ? 400 : 404;
  res.status(status).json({ error: error.code, message: error.message });
  return true;
};

/**
 * Local and shared threads share one API family and event domain, but no route
 * can change an existing thread's audience. The only audience-selecting calls
 * create a fresh server row through their audience-specific invariant.
 */
export const registerDrawingOrchestratorThreadRoutes = (
  app: express.Express,
  context: DrawingRouteContext,
) => {
  const {
    prisma,
    optionalAuth,
    requireAuth,
    asyncHandler,
    getRequestPrincipal,
    getShareToken,
    respondWithAuthErrorIfPresent,
    io,
    presences,
  } = context;

  const loadAccess = async (
    req: express.Request,
    res: express.Response,
  ): Promise<DrawingAccess | null> => {
    const access = await getDrawingAccess({
      prisma,
      principal: await getRequestPrincipal(req),
      drawingId: req.params.id,
      shareToken: getShareToken(req),
    });
    if (!canViewDrawing(access)) {
      if (respondWithAuthErrorIfPresent(req, res)) return null;
      res.status(404).json({ error: "Drawing not found" });
      return null;
    }
    return access;
  };

  const accountId = (req: express.Request): string | null =>
    req.user?.authCredentialType !== "apiKey" ? (req.user?.id ?? null) : null;

  const publishReceipt = (receipt: Awaited<ReturnType<typeof reconcileDispatchReceipt>>) => {
    if (receipt) publishBoardAgentDispatchReceipt({ io, presences, receipt });
  };
  const receiptTimers = new Map<string, NodeJS.Timeout>();
  const scheduleReceiptReconciliation = (
    receipt: NonNullable<Parameters<typeof publishReceipt>[0]>,
  ) => {
    const candidates: number[] = [];
    if (receipt.execution === "queued") candidates.push(Date.parse(receipt.startDeadlineAt));
    if (["runtime_acknowledged", "running", "blocked"].includes(receipt.execution)) {
      candidates.push(Date.parse(receipt.livenessDeadlineAt));
    }
    if (receipt.effect === "pending") candidates.push(Date.parse(receipt.effectDeadlineAt));
    if (candidates.length === 0) return;
    const existing = receiptTimers.get(receipt.id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(
      () => {
        receiptTimers.delete(receipt.id);
        void reconcileDispatchReceipt({ prisma, dispatchId: receipt.id })
          .then((next) => {
            publishReceipt(next);
            if (next) scheduleReceiptReconciliation(next);
          })
          .catch((error) =>
            reportDispatchBackgroundFailure({
              phase: "reconcile",
              dispatchId: receipt.id,
              error,
            }),
          );
      },
      Math.max(1, Math.min(...candidates) - Date.now() + 50),
    );
    timer.unref();
    receiptTimers.set(receipt.id, timer);
  };

  // Rebuild volatile timers from durable receipts after a server restart.
  // `processDispatchOutbox` can claim only `pending`; a previous `sending`
  // attempt is never repeated because its foreign outcome is unknowable.
  void listUnresolvedDispatchReceipts({ prisma })
    .then((receipts) => {
      for (const receipt of receipts) {
        scheduleReceiptReconciliation(receipt);
        void processDispatchOutbox({
          prisma,
          gateway: context.agentRuntimeGateway,
          dispatchId: receipt.id,
          onReceipt: (next) => {
            publishReceipt(next);
            scheduleReceiptReconciliation(next);
          },
        })
          .then((next) => {
            publishReceipt(next);
            if (next) scheduleReceiptReconciliation(next);
          })
          .catch((error) =>
            reportDispatchBackgroundFailure({
              phase: "restart-worker",
              dispatchId: receipt.id,
              error,
            }),
          );
      }
    })
    .catch((error) => reportDispatchBackgroundFailure({ phase: "restart-scan", error }));

  app.get(
    "/drawings/:id/orchestrator-threads",
    optionalAuth,
    asyncHandler(async (req, res) => {
      if (!(await loadAccess(req, res))) return;
      return res.json({
        threads: await listVisibleOrchestratorThreads({
          prisma,
          drawingId: req.params.id,
          userId: accountId(req),
        }),
      });
    }),
  );

  app.post(
    "/drawings/:id/orchestrator-threads/local",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!(await loadAccess(req, res))) return;
      const userId = accountId(req);
      if (!userId) return res.status(401).json({ error: "Account sign-in required" });
      const parsed = anchorSchema.safeParse(req.body?.anchor);
      if (!parsed.success) return res.status(400).json({ error: "Invalid private anchor" });
      try {
        const thread = await getOrCreatePrivateOrchestratorThread({
          prisma,
          drawingId: req.params.id,
          userId,
          initialAnchor: parsed.data,
        });
        publishBoardAgentThreadUpdated({ io, presences, thread });
        return res.status(201).json({ thread });
      } catch (error) {
        if (handleThreadError(res, error)) return;
        throw error;
      }
    }),
  );

  app.get(
    "/drawings/:id/orchestrator-threads/:threadId/dispatches",
    optionalAuth,
    asyncHandler(async (req, res) => {
      if (!(await loadAccess(req, res))) return;
      try {
        return res.json({
          receipts: await listPublicDispatchReceipts({
            prisma,
            drawingId: req.params.id,
            publicThreadId: req.params.threadId,
          }),
        });
      } catch (error) {
        if (error instanceof DispatchReceiptError) {
          return res.status(404).json({ error: error.code, message: error.message });
        }
        throw error;
      }
    }),
  );

  app.post(
    "/drawings/:id/orchestrator-threads/:threadId/dispatches",
    requireAuth,
    asyncHandler(async (req, res) => {
      const userId = accountId(req);
      if (!userId) return res.status(401).json({ error: "Account sign-in required" });
      const principal = { kind: "user" as const, userId };
      // Public work continues after this request, so a transient share token
      // cannot be its authority. The persistent account grant is re-evaluated
      // here and again by the outbox worker before crossing the runtime seam.
      const access = await getDrawingAccess({ prisma, principal, drawingId: req.params.id });
      if (!canEditDrawing(access)) return res.status(403).json({ error: "Edit access required" });
      const parsed = dispatchSchema.safeParse(req.body);
      if (!parsed.success) {
        const fanout = parsed.error.issues.some(
          (issue) => issue.path.join(".") === "approval.fanout",
        );
        return res.status(400).json({
          error: "Invalid dispatch",
          code: fanout ? "FANOUT_APPROVAL_REQUIRED" : "DISPATCH_INVALID",
        });
      }

      const dispatchId = crypto.randomUUID();
      const runId = crypto.randomUUID();
      const now = new Date();
      const endHorizonAt = new Date(now.getTime() + parsed.data.budget.maxRuntimeMs);
      const targetContextIds = [...new Set(parsed.data.targetContextIds)].sort();
      const admittedLeases: Awaited<ReturnType<typeof acquireContextLease>>[] = [];
      try {
        await getVisibleOrchestratorThread({
          prisma,
          drawingId: req.params.id,
          threadId: req.params.threadId,
          userId,
        });
        const planned = context.agentRuntimeGateway.planStart({
          access,
          principal,
          connectionId: parsed.data.connectionId,
          profileId: parsed.data.profileId,
          approvedCapabilities: parsed.data.requestedCapabilities,
        });
        const mount = await createAgentRunMount({
          prisma,
          drawingId: req.params.id,
          runId,
          allowedContextIds: targetContextIds,
          displayName: parsed.data.displayName,
          audience: { kind: "drawing" },
        });
        for (const contextId of targetContextIds) {
          admittedLeases.push(
            await acquireContextLease({
              prisma,
              contextId,
              holderOrchestratorId: req.params.threadId,
              initiatedByUserId: userId,
              runId,
              ttlMs: parsed.data.budget.maxRuntimeMs,
              endHorizonAt,
              now,
            }),
          );
        }
        const receipt = await acceptDispatchReceipt({
          prisma,
          dispatchId,
          drawingId: req.params.id,
          originThreadId: req.params.threadId,
          publicThreadId: parsed.data.publicThreadId,
          initiatedByUserId: userId,
          objectiveSummary: parsed.data.objectiveSummary,
          targetContextIds,
          revisionId: mount.revisionId,
          effectiveCapabilities: planned.effectiveCapabilities,
          budget: parsed.data.budget,
          expectedArtifacts: parsed.data.expectedArtifacts,
          runtimeConnection: planned.runtimeConnection,
          runId,
          leases: admittedLeases.map((lease) => ({
            contextId: lease.contextId,
            leaseGeneration: lease.leaseGeneration,
          })),
          runtimeRequest: {
            connectionId: parsed.data.connectionId,
            profileId: parsed.data.profileId,
            displayName: parsed.data.displayName,
            mountCapabilityToken: mount.capabilityToken,
            allowedContextIds: mount.allowedContextIds,
          },
          effectDeadlineAt: endHorizonAt,
          now,
        });

        // The durable shared receipt is emitted before the foreign start is
        // attempted. No runtime/presence signal can precede the responsibility
        // record that explains why this public work exists.
        publishBoardAgentDispatchReceipt({ io, presences, receipt });
        void processDispatchOutbox({
          prisma,
          gateway: context.agentRuntimeGateway,
          dispatchId,
          onReceipt: (next) => {
            publishReceipt(next);
            scheduleReceiptReconciliation(next);
          },
        })
          .then((next) => {
            publishReceipt(next);
            if (next) scheduleReceiptReconciliation(next);
          })
          .catch((error) =>
            reportDispatchBackgroundFailure({ phase: "initial-worker", dispatchId, error }),
          );
        scheduleReceiptReconciliation(receipt);
        return res.status(202).json({ receipt });
      } catch (error) {
        await Promise.allSettled(
          admittedLeases.map((lease) =>
            releaseContextLease({
              prisma,
              contextId: lease.contextId,
              leaseGeneration: lease.leaseGeneration,
              runId,
              callerUserId: userId,
              allowOwnerOverride: false,
            }),
          ),
        );
        await prisma.agentRunMount.deleteMany({ where: { runId } });
        if (error instanceof ContextLeaseHeldError) {
          return res.status(409).json({ error: "CONTEXT_LEASE_HELD", message: error.message });
        }
        if (error instanceof DispatchReceiptError || error instanceof OrchestratorThreadError) {
          return res.status(400).json({ error: error.code, message: error.message });
        }
        if (error instanceof AgentRuntimeError) {
          return res.status(400).json({ error: error.code, message: error.message });
        }
        throw error;
      }
    }),
  );

  app.post(
    "/drawings/:id/orchestrator-threads/shared",
    optionalAuth,
    asyncHandler(async (req, res) => {
      const access = await loadAccess(req, res);
      if (!access) return;
      if (!canEditDrawing(access)) return res.status(403).json({ error: "Edit access required" });
      const parsed = sharedSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid shared anchor" });
      try {
        const thread = await registerDrawingOrchestratorThread({
          prisma,
          drawingId: req.params.id,
          anchorElementId: parsed.data.anchorElementId,
        });
        publishBoardAgentThreadUpdated({ io, presences, thread });
        return res.status(201).json({ thread });
      } catch (error) {
        if (handleThreadError(res, error)) return;
        throw error;
      }
    }),
  );

  app.patch(
    "/drawings/:id/orchestrator-threads/:threadId/local-anchor",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!(await loadAccess(req, res))) return;
      const userId = accountId(req);
      if (!userId) return res.status(401).json({ error: "Account sign-in required" });
      const parsed = anchorSchema.safeParse(req.body?.anchor);
      if (!parsed.success) return res.status(400).json({ error: "Invalid private anchor" });
      try {
        const thread = await movePrivateOrchestratorThread({
          prisma,
          drawingId: req.params.id,
          threadId: req.params.threadId,
          userId,
          anchor: parsed.data,
        });
        publishBoardAgentThreadUpdated({ io, presences, thread });
        return res.json({ thread });
      } catch (error) {
        if (handleThreadError(res, error)) return;
        throw error;
      }
    }),
  );

  app.get(
    "/drawings/:id/orchestrator-threads/:threadId/events",
    optionalAuth,
    asyncHandler(async (req, res) => {
      if (!(await loadAccess(req, res))) return;
      try {
        const afterSequence = Number(req.query.afterSequence ?? 0);
        return res.json({
          events: await listOrchestratorThreadEvents({
            prisma,
            drawingId: req.params.id,
            threadId: req.params.threadId,
            userId: accountId(req),
            afterSequence: Number.isSafeInteger(afterSequence) ? afterSequence : 0,
          }),
        });
      } catch (error) {
        if (handleThreadError(res, error)) return;
        throw error;
      }
    }),
  );

  app.post(
    "/drawings/:id/orchestrator-threads/:threadId/events",
    requireAuth,
    asyncHandler(async (req, res) => {
      const access = await loadAccess(req, res);
      if (!access) return;
      const userId = accountId(req);
      if (!userId || !req.user) {
        return res.status(401).json({ error: "Account sign-in required" });
      }
      const parsed = messageSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid message" });
      try {
        const visible = await getVisibleOrchestratorThread({
          prisma,
          drawingId: req.params.id,
          threadId: req.params.threadId,
          userId,
        });
        if (visible.audience.kind === "drawing" && !canEditDrawing(access)) {
          return res.status(403).json({ error: "Edit access required" });
        }
        const { thread, event } = await appendOrchestratorThreadMessage({
          prisma,
          drawingId: req.params.id,
          threadId: req.params.threadId,
          userId,
          displayName: req.user.name,
          text: parsed.data.text,
        });
        publishBoardAgentThreadEvent({ io, presences, thread, event });
        return res.status(201).json({ event });
      } catch (error) {
        if (handleThreadError(res, error)) return;
        throw error;
      }
    }),
  );
};
