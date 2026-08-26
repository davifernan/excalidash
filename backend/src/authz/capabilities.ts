import type { PrismaClient } from "../generated/client";
import { getDrawingMembership } from "./membership";
import {
  canEditDrawing,
  canViewDrawing,
  getDrawingAccess,
  type DrawingAccess,
  type DrawingPrincipal,
} from "./sharing";

/**
 * The behavior that existed before guest policy was persisted.
 *
 * These are also the safe answer while a singleton SystemConfig row is being
 * created: uploads stay closed and comment reads stay open. The migration
 * writes the same values explicitly into every existing row; these constants
 * are runtime absence handling, not a substitute for migrated data.
 */
export const HISTORICAL_GUEST_CAPABILITY_DEFAULTS = {
  uploadFiles: false,
  viewComments: true,
} as const;

export type EffectiveDrawingCapabilities = {
  uploadFiles: boolean;
  viewComments: boolean;
};

export type DrawingCapabilityDecision = {
  access: DrawingAccess;
  /** A link-only visitor, including a signed-in account with no standing claim. */
  isGuest: boolean;
  capabilities: EffectiveDrawingCapabilities;
};

type DrawingCapabilityParams = {
  prisma: PrismaClient;
  principal: DrawingPrincipal | null;
  drawingId: string;
  shareToken?: string | null;
  now?: Date;
  isUserActive?: (userId: string) => Promise<boolean>;
};

/**
 * Resolve access provenance and both guest policies as one authorization
 * decision. Routes consume the result; they do not reconstruct it from
 * DrawingPermission, link shares, or policy columns themselves.
 */
export const getDrawingCapabilities = async (
  params: DrawingCapabilityParams,
): Promise<DrawingCapabilityDecision> => {
  const access = await getDrawingAccess(params);
  if (!canViewDrawing(access)) {
    return {
      access,
      isGuest: true,
      capabilities: { uploadFiles: false, viewComments: false },
    };
  }

  // Auth-disabled mode deliberately uses one shared bootstrap principal. It
  // is the local instance identity, not a link guest, and must retain the same
  // owner/editor behavior it had before guest policy existed.
  const membership =
    access !== "owner" && params.principal?.kind === "user" && !params.principal.allowInactive
      ? await getDrawingMembership({
          prisma: params.prisma,
          userId: params.principal.userId,
          drawingId: params.drawingId,
        })
      : null;
  const isGuest = access !== "owner" && !params.principal?.allowInactive && !membership;
  if (!isGuest) {
    return {
      access,
      isGuest: false,
      capabilities: {
        uploadFiles: canEditDrawing(access),
        viewComments: true,
      },
    };
  }

  const [drawingPolicy, instancePolicy] = await Promise.all([
    params.prisma.drawing.findUnique({
      where: { id: params.drawingId },
      select: {
        guestUploadEnabled: true,
        guestCommentVisibilityEnabled: true,
      },
    }),
    params.prisma.systemConfig.findUnique({
      where: { id: "default" },
      select: {
        guestUploadEnabled: true,
        guestCommentVisibilityEnabled: true,
      },
    }),
  ]);

  const instanceUpload =
    instancePolicy?.guestUploadEnabled ?? HISTORICAL_GUEST_CAPABILITY_DEFAULTS.uploadFiles;
  const instanceComments =
    instancePolicy?.guestCommentVisibilityEnabled ??
    HISTORICAL_GUEST_CAPABILITY_DEFAULTS.viewComments;
  const boardUpload =
    drawingPolicy?.guestUploadEnabled ?? HISTORICAL_GUEST_CAPABILITY_DEFAULTS.uploadFiles;
  const boardComments =
    drawingPolicy?.guestCommentVisibilityEnabled ??
    HISTORICAL_GUEST_CAPABILITY_DEFAULTS.viewComments;

  return {
    access,
    isGuest: true,
    capabilities: {
      uploadFiles: canEditDrawing(access) && instanceUpload && boardUpload,
      viewComments: instanceComments && boardComments,
    },
  };
};

/** Whether a scene payload carries bytes that would enter file storage. */
export const hasEmbeddedFileUpload = (files: unknown): boolean => {
  if (!files || typeof files !== "object" || Array.isArray(files)) return false;
  return Object.values(files as Record<string, unknown>).some((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const dataURL = (entry as Record<string, unknown>).dataURL;
    return typeof dataURL === "string" && dataURL.startsWith("data:");
  });
};

export const GUEST_UPLOAD_DENIED = {
  error: "Guest upload disabled",
  code: "GUEST_UPLOAD_DISABLED",
  message: "Guests cannot upload files to this board. Ask the board owner to enable guest uploads.",
} as const;
