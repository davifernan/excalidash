import { createReadStream } from "node:fs";
import type { Express, Request, Response } from "express";
import { ipKeyGenerator } from "express-rate-limit";
import { canViewDrawing, getDrawingAccess, shareLinkTokenFromRequest } from "../authz/sharing";
import { QueueCapacityError } from "../utils/boundedTaskQueue";
import { resolveStoragePath } from "../assets/assetStorage";
import { LinkPreviewBusyError, type LinkPreviewResult } from "./service";
import { PreviewFetchError } from "./network";

type RouteDeps = {
  app: Express;
  prisma: any;
  requireAuth: any;
  asyncHandler: any;
  storageDir: string;
  getPreview: (userId: string, url: string) => Promise<LinkPreviewResult>;
  authorizeDrawing?: (req: Request, drawingId: string) => Promise<boolean>;
  now?: () => number;
};

const ID = /^[a-f0-9-]{36}$/i;
const DRAWING_ID_MAX_LENGTH = 200;
// With two per-actor workers and an eight-second fetch ceiling, twelve starts
// per minute allows normal cards but prevents one actor from continuously
// refilling the instance queue. This is an abuse ceiling, not a tuning knob.
const QUOTA_WINDOW_MS = 60_000;
const QUOTA_MAX_REQUESTS = 12;

type QuotaEntry = { count: number; resetAt: number };

class ActorQuota {
  private readonly entries = new Map<string, QuotaEntry>();
  private nextSweepAt = 0;

  consume(actorKey: string, now: number): { allowed: boolean; retryAfterSeconds: number } {
    if (now >= this.nextSweepAt) {
      for (const [key, entry] of this.entries) {
        if (entry.resetAt <= now) this.entries.delete(key);
      }
      this.nextSweepAt = now + QUOTA_WINDOW_MS;
    }
    const current = this.entries.get(actorKey);
    if (!current || current.resetAt <= now) {
      this.entries.set(actorKey, { count: 1, resetAt: now + QUOTA_WINDOW_MS });
      return { allowed: true, retryAfterSeconds: Math.ceil(QUOTA_WINDOW_MS / 1000) };
    }
    const retryAfterSeconds = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
    if (current.count >= QUOTA_MAX_REQUESTS) return { allowed: false, retryAfterSeconds };
    current.count += 1;
    return { allowed: true, retryAfterSeconds };
  }
}

const actorKeyFor = (req: Request): string => {
  if (req.user?.id && req.user.authCredentialType !== "bootstrap") {
    return `account:${req.user.id}`;
  }
  return `address:${ipKeyGenerator(req.ip || "") || "anonymous"}`;
};

const requestPrincipal = (req: Request) => {
  if (req.user?.authCredentialType === "bootstrap" && req.user.id) {
    return { kind: "user" as const, userId: req.user.id, allowInactive: true };
  }
  return req.principal ?? (req.user?.id ? { kind: "user" as const, userId: req.user.id } : null);
};

function responseFor(row: LinkPreviewResult) {
  return {
    id: row.id,
    url: row.requestedUrl,
    resolvedUrl: row.resolvedUrl,
    title: row.title,
    description: row.description,
    imageUrl: row.imageBlobId ? `/api/link-previews/${row.id}/image` : null,
    faviconUrl: row.faviconBlobId ? `/api/link-previews/${row.id}/favicon` : null,
  };
}

export function registerLinkPreviewRoutes(deps: RouteDeps): void {
  const quota = new ActorQuota();
  const authorizeDrawing =
    deps.authorizeDrawing ??
    (async (req: Request, drawingId: string) =>
      canViewDrawing(
        await getDrawingAccess({
          prisma: deps.prisma,
          principal: requestPrincipal(req),
          drawingId,
          shareToken: shareLinkTokenFromRequest(req),
        }),
      ));

  deps.app.post(
    "/link-previews",
    deps.requireAuth,
    deps.asyncHandler(async (req: Request, res: Response) => {
      const drawingId = typeof req.body?.drawingId === "string" ? req.body.drawingId.trim() : "";
      const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
      if (!drawingId || drawingId.length > DRAWING_ID_MAX_LENGTH) {
        return res.status(400).json({
          error: "Invalid drawing",
          message: "A drawingId is required.",
        });
      }
      if (!url || url.length > 4_096) {
        return res.status(400).json({ error: "Invalid URL", message: "A URL is required." });
      }
      if (!(await authorizeDrawing(req, drawingId))) {
        return res.status(404).json({
          error: "Drawing not found",
          message: "Drawing does not exist",
        });
      }
      const admission = quota.consume(actorKeyFor(req), deps.now?.() ?? Date.now());
      if (!admission.allowed) {
        res.setHeader("Retry-After", String(admission.retryAfterSeconds));
        return res.status(429).json({
          error: "Preview rate limit reached",
          code: "LINK_PREVIEW_RATE_LIMITED",
          message: "Too many link previews were requested. Try again shortly.",
        });
      }
      try {
        const preview = await deps.getPreview(req.user!.id, url);
        res.setHeader("Cache-Control", "private, no-store");
        if (preview.status === "NEGATIVE") {
          return res.status(422).json({
            error: "Preview unavailable",
            code: preview.failureCode,
            message: "No safe preview could be produced for this URL.",
          });
        }
        return res.json(responseFor(preview));
      } catch (error) {
        if (error instanceof LinkPreviewBusyError || error instanceof QueueCapacityError) {
          res.setHeader("Retry-After", "2");
          return res.status(429).json({
            error: "Preview limit reached",
            message: "Too many link previews are being fetched. Try again shortly.",
          });
        }
        if (error instanceof PreviewFetchError && error.code === "INVALID_URL") {
          return res.status(400).json({ error: "Invalid URL", message: error.message });
        }
        throw error;
      }
    }),
  );

  deps.app.get(
    "/link-previews/:id/:kind",
    deps.requireAuth,
    deps.asyncHandler(async (req: Request, res: Response) => {
      if (!ID.test(req.params.id) || !["image", "favicon"].includes(req.params.kind)) {
        return res.status(404).json({ error: "Preview not found" });
      }
      const preview = await deps.prisma.linkPreview.findUnique({
        where: { id: req.params.id },
        include: { imageBlob: true, faviconBlob: true },
      });
      if (!preview || preview.expiresAt.getTime() <= (deps.now?.() ?? Date.now())) {
        return res.status(404).json({ error: "Preview not found" });
      }
      const blob = req.params.kind === "image" ? preview.imageBlob : preview.faviconBlob;
      if (!blob) return res.status(404).json({ error: "Preview image not found" });

      res.setHeader("Content-Type", "image/webp");
      res.setHeader("Content-Length", String(blob.sizeBytes));
      res.setHeader("Content-Disposition", "inline");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.setHeader("Vary", "Cookie, Authorization");
      res.setHeader("ETag", `"${blob.sha256}"`);
      if (req.headers["if-none-match"] === `"${blob.sha256}"`) return res.status(304).end();
      return createReadStream(resolveStoragePath(deps.storageDir, blob.storageKey)).pipe(res);
    }),
  );
}
