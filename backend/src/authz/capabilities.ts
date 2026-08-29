import type { PrismaClient } from "../generated/client";
import { DEFAULT_SYSTEM_CONFIG_ID } from "../auth/authMode";
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

/**
 * The instance-wide ceiling, read straight from the singleton SystemConfig
 * row. A board cannot raise what this returns -- see combineGuestCapabilities.
 */
export const getInstanceGuestCapabilities = async (
  prisma: PrismaClient,
  systemConfigId: string = DEFAULT_SYSTEM_CONFIG_ID,
): Promise<EffectiveDrawingCapabilities> => {
  const instancePolicy = await prisma.systemConfig.findUnique({
    where: { id: systemConfigId },
    select: { guestUploadEnabled: true, guestCommentVisibilityEnabled: true },
  });
  return {
    uploadFiles:
      instancePolicy?.guestUploadEnabled ?? HISTORICAL_GUEST_CAPABILITY_DEFAULTS.uploadFiles,
    viewComments:
      instancePolicy?.guestCommentVisibilityEnabled ??
      HISTORICAL_GUEST_CAPABILITY_DEFAULTS.viewComments,
  };
};

/** Admin-only write. Callers authorize before calling this. */
export const setInstanceGuestCapabilities = async (
  prisma: PrismaClient,
  updates: Partial<EffectiveDrawingCapabilities>,
  systemConfigId: string = DEFAULT_SYSTEM_CONFIG_ID,
): Promise<EffectiveDrawingCapabilities> => {
  const updated = await prisma.systemConfig.upsert({
    where: { id: systemConfigId },
    update: {
      ...(updates.uploadFiles !== undefined ? { guestUploadEnabled: updates.uploadFiles } : {}),
      ...(updates.viewComments !== undefined
        ? { guestCommentVisibilityEnabled: updates.viewComments }
        : {}),
    },
    create: {
      id: systemConfigId,
      guestUploadEnabled: updates.uploadFiles ?? HISTORICAL_GUEST_CAPABILITY_DEFAULTS.uploadFiles,
      guestCommentVisibilityEnabled:
        updates.viewComments ?? HISTORICAL_GUEST_CAPABILITY_DEFAULTS.viewComments,
    },
  });
  return {
    uploadFiles: updated.guestUploadEnabled,
    viewComments: updated.guestCommentVisibilityEnabled,
  };
};

/** The board's own policy, before it is capped by the instance ceiling. */
export const getBoardGuestCapabilityPolicy = async (
  prisma: PrismaClient,
  drawingId: string,
): Promise<EffectiveDrawingCapabilities> => {
  const drawingPolicy = await prisma.drawing.findUnique({
    where: { id: drawingId },
    select: { guestUploadEnabled: true, guestCommentVisibilityEnabled: true },
  });
  return {
    uploadFiles:
      drawingPolicy?.guestUploadEnabled ?? HISTORICAL_GUEST_CAPABILITY_DEFAULTS.uploadFiles,
    viewComments:
      drawingPolicy?.guestCommentVisibilityEnabled ??
      HISTORICAL_GUEST_CAPABILITY_DEFAULTS.viewComments,
  };
};

/** Board-owner-only write. Callers authorize (controlsDrawing) before calling this. */
export const setBoardGuestCapabilityPolicy = async (
  prisma: PrismaClient,
  drawingId: string,
  updates: Partial<EffectiveDrawingCapabilities>,
): Promise<EffectiveDrawingCapabilities> => {
  const updated = await prisma.drawing.update({
    where: { id: drawingId },
    data: {
      ...(updates.uploadFiles !== undefined ? { guestUploadEnabled: updates.uploadFiles } : {}),
      ...(updates.viewComments !== undefined
        ? { guestCommentVisibilityEnabled: updates.viewComments }
        : {}),
    },
    select: { guestUploadEnabled: true, guestCommentVisibilityEnabled: true },
  });
  return {
    uploadFiles: updated.guestUploadEnabled,
    viewComments: updated.guestCommentVisibilityEnabled,
  };
};

/**
 * The one place that turns an instance ceiling and a board policy into what a
 * guest actually gets: AND, per function. Routes and the settings UI both
 * read this instead of each re-deriving the same two booleans -- the UI's
 * "the board cannot raise the instance ceiling" copy would otherwise be a
 * second, driftable copy of this rule.
 */
export const combineGuestCapabilities = (
  instance: EffectiveDrawingCapabilities,
  board: EffectiveDrawingCapabilities,
): EffectiveDrawingCapabilities => ({
  uploadFiles: instance.uploadFiles && board.uploadFiles,
  viewComments: instance.viewComments && board.viewComments,
});

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

  const [boardPolicy, instancePolicy] = await Promise.all([
    getBoardGuestCapabilityPolicy(params.prisma, params.drawingId),
    getInstanceGuestCapabilities(params.prisma),
  ]);
  const effective = combineGuestCapabilities(instancePolicy, boardPolicy);

  return {
    access,
    isGuest: true,
    capabilities: {
      uploadFiles: canEditDrawing(access) && effective.uploadFiles,
      viewComments: effective.viewComments,
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

const embeddedPreviewImageDataUrls = (preview: unknown): string[] => {
  if (typeof preview !== "string") return [];
  const urls: string[] = [];
  const imageHref =
    /<image\b[^>]*\s(?:href|xlink:href)\s*=\s*(?:"\s*(data:image\/[^\"]*)"|'\s*(data:image\/[^']*)')/gi;
  for (const match of preview.matchAll(imageHref)) {
    const url = match[1] ?? match[2];
    if (url) urls.push(url);
  }
  return urls;
};

/** Whether a persisted SVG preview carries inline image bytes. */
export const hasEmbeddedPreviewUpload = (preview: unknown): boolean => {
  return embeddedPreviewImageDataUrls(preview).length > 0;
};

/**
 * Whether an update would introduce image bytes that are not already stored
 * on this drawing. Replaying a legacy inline preview is not an upload: it
 * cannot increase storage, so it must not prevent an otherwise editable
 * board from saving its text or geometry. A new inline image still is an
 * upload, including the preview-only autosave path that this guard closes.
 */
export const hasEmbeddedDrawingUpload = (
  payload: {
    files?: unknown;
    preview?: unknown;
  },
  existing: {
    files?: unknown;
    preview?: unknown;
  } = {},
): boolean => {
  const existingFiles =
    existing.files && typeof existing.files === "object" && !Array.isArray(existing.files)
      ? (existing.files as Record<string, unknown>)
      : {};
  const filesContainNewBytes =
    payload.files && typeof payload.files === "object" && !Array.isArray(payload.files)
      ? Object.entries(payload.files as Record<string, unknown>).some(([fileId, entry]) => {
          const dataURL =
            entry && typeof entry === "object" && !Array.isArray(entry)
              ? (entry as Record<string, unknown>).dataURL
              : null;
          const existingDataURL =
            existingFiles[fileId] &&
            typeof existingFiles[fileId] === "object" &&
            !Array.isArray(existingFiles[fileId])
              ? (existingFiles[fileId] as Record<string, unknown>).dataURL
              : null;
          return (
            typeof dataURL === "string" &&
            dataURL.startsWith("data:") &&
            dataURL !== existingDataURL
          );
        })
      : false;
  if (filesContainNewBytes) return true;

  const existingUrls = new Set(embeddedPreviewImageDataUrls(existing.preview));
  return embeddedPreviewImageDataUrls(payload.preview).some((url) => !existingUrls.has(url));
};

export const GUEST_UPLOAD_DENIED = {
  error: "Guest upload disabled",
  code: "GUEST_UPLOAD_DISABLED",
  message: "Guests cannot upload files to this board. Ask the board owner to enable guest uploads.",
} as const;
