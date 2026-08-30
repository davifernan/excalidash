import express from "express";
import { z } from "zod";
import { canEditDrawing, canViewDrawing, getDrawingAccess } from "../../authz/sharing";
import {
  InstructionApprovalError,
  approveInstruction,
  previewInstructionApproval,
  readInstructionApprovalStatus,
  upsertInstructionSemanticRelation,
} from "../../agent/instructionApprovals";
import { INSTRUCTION_RELATION_KINDS } from "../../agent/instructionClosure";
import type { DrawingRouteContext } from "./drawingRouteContext";

const elementId = z.string().min(1).max(200);
const relationSchema = z.object({
  fromElementId: elementId,
  toElementId: elementId,
  kind: z.enum(INSTRUCTION_RELATION_KINDS),
});
const approvalSchema = z.object({ expectedClosureHash: z.string().regex(/^[a-f0-9]{64}$/i) });

const respondApprovalError = (res: express.Response, error: unknown): boolean => {
  if (!(error instanceof InstructionApprovalError)) return false;
  const status =
    error.code === "CONTEXT_NOT_FOUND" || error.code === "APPROVAL_NOT_FOUND"
      ? 404
      : error.code === "INSTRUCTION_NOT_TEXT" || error.code === "SEMANTIC_RELATION_INVALID"
        ? 400
        : 409;
  res
    .status(status)
    .json({ error: "Instruction approval error", code: error.code, message: error.message });
  return true;
};

/**
 * Approval is intentionally a tiny human-only surface. It has no call to the
 * runtime gateway: approving a note and dispatching an agent are separate
 * gestures, even when both controls later live in the same Context widget.
 */
export const registerDrawingInstructionApprovalRoutes = (
  app: express.Express,
  context: DrawingRouteContext,
) => {
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
    return true;
  };

  app.get(
    "/drawings/:id/instruction-contexts",
    optionalAuth,
    asyncHandler(async (req, res) => {
      if (!(await load(req, res, false))) return;
      const contexts = await prisma.agentContext.findMany({
        where: { drawingId: req.params.id },
        select: { id: true, frameElementId: true },
        orderBy: { createdAt: "asc" },
      });
      return res.json({ contexts });
    }),
  );

  app.get(
    "/drawings/:id/instruction-contexts/:contextId/instructions/:elementId/approval",
    optionalAuth,
    asyncHandler(async (req, res) => {
      if (!(await load(req, res, false))) return;
      try {
        return res.json(
          await readInstructionApprovalStatus({
            prisma,
            drawingId: req.params.id,
            contextId: req.params.contextId,
            elementId: req.params.elementId,
          }),
        );
      } catch (error) {
        if (respondApprovalError(res, error)) return;
        throw error;
      }
    }),
  );

  app.put(
    "/drawings/:id/instruction-contexts/:contextId/semantic-relations",
    optionalAuth,
    asyncHandler(async (req, res) => {
      if (!(await load(req, res, true))) return;
      // Link-only editors and API keys cannot attribute a human semantic
      // declaration. This is an anti-authority-laundering boundary, not a
      // second board-access model.
      if (!req.user?.id || req.user.authCredentialType === "apiKey") {
        return res.status(401).json({ error: "Sign in to declare semantic meaning" });
      }
      const parsed = relationSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Invalid semantic relation" });
      try {
        return res.status(201).json({
          relation: await upsertInstructionSemanticRelation({
            prisma,
            drawingId: req.params.id,
            contextId: req.params.contextId,
            createdByUserId: req.user.id,
            ...parsed.data,
          }),
        });
      } catch (error) {
        if (respondApprovalError(res, error)) return;
        throw error;
      }
    }),
  );

  app.post(
    "/drawings/:id/instruction-contexts/:contextId/instructions/:elementId/approval",
    optionalAuth,
    asyncHandler(async (req, res) => {
      if (!(await load(req, res, true))) return;
      if (!req.user?.id || req.user.authCredentialType === "apiKey") {
        return res.status(401).json({ error: "Sign in to approve an instruction" });
      }
      const parsed = approvalSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "Preview hash required" });
      try {
        return res.status(201).json(
          await approveInstruction({
            prisma,
            drawingId: req.params.id,
            contextId: req.params.contextId,
            elementId: req.params.elementId,
            approvedByUserId: req.user.id,
            expectedClosureHash: parsed.data.expectedClosureHash,
          }),
        );
      } catch (error) {
        if (respondApprovalError(res, error)) return;
        throw error;
      }
    }),
  );

  app.get(
    "/drawings/:id/instruction-contexts/:contextId/instructions/:elementId/approval-preview",
    optionalAuth,
    asyncHandler(async (req, res) => {
      if (!(await load(req, res, true))) return;
      try {
        return res.json(
          await previewInstructionApproval({
            prisma,
            drawingId: req.params.id,
            contextId: req.params.contextId,
            elementId: req.params.elementId,
          }),
        );
      } catch (error) {
        if (respondApprovalError(res, error)) return;
        throw error;
      }
    }),
  );
};
