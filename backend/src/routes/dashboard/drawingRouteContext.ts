import express from "express";
import { DashboardRouteDeps } from "./types";
import {
  buildS3Key,
  copyS3Object,
  deleteS3Object,
  drawingS3Prefix,
  getPublicUrl,
  getS3Config,
  isS3Enabled,
  listS3Objects,
} from "../../s3";
import {
  shareLinkTokenFromRequest,
  type DrawingPermission,
  type DrawingPrincipal,
} from "../../authz/sharing";
import { cloneDrawingFiles } from "../../assets/assetService";

export type DrawingRouteContext = DashboardRouteDeps & {
  getRequestPrincipal: (req: express.Request) => Promise<DrawingPrincipal | null>;
  getShareToken: (req: express.Request) => string | null;
  resolveDefaultTtlMs: (permission: DrawingPermission) => number;
  resolveMaxTtlMs: () => number;
  respondWithAuthErrorIfPresent: (req: express.Request, res: express.Response) => boolean;
  cleanupS3FilesForDrawing: (drawingId: string, userId: string) => Promise<void>;
  cloneS3FileReferences: (
    sourceDrawingId: string,
    targetDrawingId: string,
    userId: string,
    files: Record<string, any>,
  ) => Promise<Record<string, any>>;
  cloneDrawingFileReferences: (
    sourceDrawingId: string,
    targetDrawingId: string,
    ownerUserId: string,
    files: Record<string, any>,
  ) => Promise<Record<string, any>>;
};

export const createDrawingRouteContext = (deps: DashboardRouteDeps): DrawingRouteContext => {
  const { prisma } = deps;

  const getRequestPrincipal = async (req: express.Request): Promise<DrawingPrincipal | null> => {
    if (req.user?.authCredentialType === "bootstrap" && req.user.id) {
      return { kind: "user", userId: req.user.id, allowInactive: true };
    }
    if (req.principal) return req.principal;
    if (req.user?.id) return { kind: "user", userId: req.user.id };
    return null;
  };

  const getShareToken = (req: express.Request): string | null => shareLinkTokenFromRequest(req);

  /**
   * A shorter life for links that can change the board.
   *
   * `"comment"` groups with `"view"` rather than `"edit"`: the short window
   * exists because a leaked edit link can destroy work, and a comment link
   * cannot. Typed as DrawingPermission instead of a hand-written union, which
   * is how the compiler pointed at this function the moment the level was
   * added -- a local copy of the union would have kept its silence and quietly
   * given comment links the edit TTL.
   */
  const resolveDefaultTtlMs = (permission: DrawingPermission): number => {
    const raw =
      permission === "edit"
        ? process.env.LINK_SHARE_EDIT_DEFAULT_TTL_MS
        : process.env.LINK_SHARE_VIEW_DEFAULT_TTL_MS;
    const parsed = raw ? Number(raw) : NaN;
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    return permission === "edit" ? 7 * 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;
  };

  const resolveMaxTtlMs = (): number => {
    const parsed = Number(process.env.LINK_SHARE_MAX_TTL_MS);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    return 90 * 24 * 60 * 60 * 1000;
  };

  const respondWithAuthErrorIfPresent = (req: express.Request, res: express.Response): boolean => {
    if (!req.authError) return false;
    res.status(401).json({
      error: "Unauthorized",
      message: "Invalid or expired token",
    });
    return true;
  };

  /**
   * `userId` in `cleanupS3FilesForDrawing` and `cloneS3FileReferences` below is an S3 path
   * key, not an ownership filter: it namespaces the object prefix (`drawingS3Prefix`,
   * `buildS3Key`) and the `S3File` row lookup, and neither function decides who may act on
   * the drawing -- callers resolve that through backend/src/authz/ before reaching here.
   * Counting the `userId` occurrences below and reading them as an authz boundary check
   * misreads the file (NIL-489); the occurrence count says nothing about what each one does.
   */
  const cleanupS3FilesForDrawing = async (drawingId: string, userId: string): Promise<void> => {
    if (!isS3Enabled()) return;

    const [objects, records] = await Promise.all([
      listS3Objects(drawingS3Prefix(userId, drawingId)),
      prisma.s3File.findMany({ where: { drawingId, userId } }),
    ]);
    const keys = new Set<string>(objects.map((object) => object.key));
    for (const record of records) keys.add(record.s3Key);

    await Promise.allSettled([...keys].map((key) => deleteS3Object(key)));
    await prisma.s3File.deleteMany({ where: { drawingId, userId } });
  };

  const cloneS3FileReferences = async (
    sourceDrawingId: string,
    targetDrawingId: string,
    userId: string,
    files: Record<string, any>,
  ): Promise<Record<string, any>> => {
    if (!isS3Enabled()) return files;

    const records = await prisma.s3File.findMany({
      where: { drawingId: sourceDrawingId, userId },
    });
    if (records.length === 0) return files;

    const clonedFiles: Record<string, any> = { ...files };
    const cfg = getS3Config();
    await Promise.all(
      records.map(async (record) => {
        const extension = record.s3Key.includes(".")
          ? record.s3Key.substring(record.s3Key.lastIndexOf(".") + 1)
          : "bin";
        const targetKey = buildS3Key(userId, targetDrawingId, record.fileId, extension);
        await copyS3Object(record.s3Key, targetKey, record.mimeType);
        await prisma.s3File.upsert({
          where: { drawingId_fileId: { drawingId: targetDrawingId, fileId: record.fileId } },
          create: {
            drawingId: targetDrawingId,
            fileId: record.fileId,
            userId,
            s3Key: targetKey,
            mimeType: record.mimeType,
          },
          update: { s3Key: targetKey, mimeType: record.mimeType },
        });
        if (clonedFiles[record.fileId]) {
          clonedFiles[record.fileId] = {
            ...clonedFiles[record.fileId],
            dataURL: cfg?.publicUrl
              ? getPublicUrl(targetKey)
              : `/api/files/${targetDrawingId}/${record.fileId}`,
          };
        }
      }),
    );

    return clonedFiles;
  };

  /**
   * The NIL-381 board-image counterpart to cloneS3FileReferences above --
   * kept as its own function rather than folded into it because the two
   * storage paths have nothing in common past "duplicate a board's images":
   * one copies bytes between S3 keys, the other only ever adds a reference
   * row to an already-deduped blob.
   */
  const cloneDrawingFileReferences = async (
    sourceDrawingId: string,
    targetDrawingId: string,
    ownerUserId: string,
    files: Record<string, any>,
  ): Promise<Record<string, any>> => {
    const fileIds = await cloneDrawingFiles(prisma, sourceDrawingId, targetDrawingId, ownerUserId);
    if (fileIds.length === 0) return files;

    const clonedFiles: Record<string, any> = { ...files };
    for (const fileId of fileIds) {
      if (clonedFiles[fileId]) {
        clonedFiles[fileId] = {
          ...clonedFiles[fileId],
          dataURL: `/api/files/${targetDrawingId}/${fileId}`,
        };
      }
    }
    return clonedFiles;
  };

  return {
    ...deps,
    getRequestPrincipal,
    getShareToken,
    resolveDefaultTtlMs,
    resolveMaxTtlMs,
    respondWithAuthErrorIfPresent,
    cleanupS3FilesForDrawing,
    cloneS3FileReferences,
    cloneDrawingFileReferences,
  };
};
