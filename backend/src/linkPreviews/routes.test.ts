import { describe, expect, it, vi } from "vitest";
import { hashShareLinkToken } from "../authz/sharing";
import { registerLinkPreviewRoutes } from "./routes";

function routeHarness(
  requireAuth: any,
  getPreview: any,
  options: {
    authorizeDrawing?: (req: any, drawingId: string) => Promise<boolean>;
    prisma?: any;
  } = {},
) {
  const routes = new Map<string, any[]>();
  const app = {
    post: (path: string, ...handlers: any[]) => routes.set(`POST ${path}`, handlers),
    get: (path: string, ...handlers: any[]) => routes.set(`GET ${path}`, handlers),
  };
  registerLinkPreviewRoutes({
    app: app as any,
    prisma: options.prisma ?? {},
    storageDir: "/unused",
    getPreview,
    asyncHandler: (fn: any) => fn,
    requireAuth,
    authorizeDrawing: options.authorizeDrawing ?? (options.prisma ? undefined : async () => true),
  } as any);
  const req: any = {
    body: { drawingId: "drawing-1", url: "https://example.com" },
    headers: {},
    query: {},
    ip: "203.0.113.10",
  };
  const res: any = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: any) {
      this.body = body;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
  };
  const invokePost = async () => {
    res.statusCode = 200;
    res.body = null;
    res.headers = {};
    const [auth, handler] = routes.get("POST /link-previews")!;
    let nextCalled = false;
    await auth(req, res, () => {
      nextCalled = true;
    });
    if (nextCalled) await handler(req, res);
    return res;
  };
  return { req, invokePost };
}

const readyPreview = () => ({
  id: "00000000-0000-0000-0000-000000000001",
  status: "READY" as const,
  failureCode: null,
  requestedUrl: "https://example.com",
  resolvedUrl: "https://example.com",
  title: "Example",
  description: null,
  imageBlobId: null,
  faviconBlobId: null,
});

const shareOnlyPrisma = (token: string, expiresAt: Date | null = null) => ({
  user: { findUnique: vi.fn().mockResolvedValue({ isActive: true }) },
  drawing: {
    findUnique: vi.fn().mockResolvedValue({ userId: "owner", collectionId: null }),
  },
  drawingPermission: { findUnique: vi.fn().mockResolvedValue(null) },
  drawingLinkShare: {
    findFirst: vi.fn(async ({ where }: any) => {
      const now = where.OR[1].expiresAt.gt as Date;
      if (expiresAt && expiresAt <= now) return null;
      return { permission: "view", tokenHash: hashShareLinkToken(token) };
    }),
  },
});

describe("link preview routes", () => {
  it("does not invoke the preview service for signed-out callers", async () => {
    const getPreview = vi.fn();
    const harness = routeHarness(
      (_req: any, res: any) => res.status(401).json({ error: "Unauthorized" }),
      getPreview,
    );

    expect((await harness.invokePost()).statusCode).toBe(401);
    expect(getPreview).not.toHaveBeenCalled();
  });

  it("requires a drawing id before invoking the preview service", async () => {
    const getPreview = vi.fn(async () => ({
      status: "READY",
      imageBlobId: null,
      faviconBlobId: null,
    }));
    const harness = routeHarness((req: any, _res: any, next: any) => {
      req.user = { id: "user-1" };
      next();
    }, getPreview);
    delete harness.req.body.drawingId;

    expect((await harness.invokePost()).statusCode).toBe(400);
    expect(getPreview).not.toHaveBeenCalled();
  });

  it("does not fetch for a drawing the caller cannot view", async () => {
    const getPreview = vi.fn(async () => ({
      status: "READY",
      imageBlobId: null,
      faviconBlobId: null,
    }));
    const harness = routeHarness(
      (req: any, _res: any, next: any) => {
        req.user = { id: "user-1" };
        next();
      },
      getPreview,
      { authorizeDrawing: async () => false },
    );

    expect((await harness.invokePost()).statusCode).toBe(404);
    expect(getPreview).not.toHaveBeenCalled();
  });

  it("serves a preview when an account has access only through a valid share link", async () => {
    const shareToken = "s".repeat(32);
    const getPreview = vi.fn(readyPreview);
    const harness = routeHarness(
      (req: any, _res: any, next: any) => {
        req.user = { id: "link-viewer", authCredentialType: "jwt" };
        next();
      },
      getPreview,
      { prisma: shareOnlyPrisma(shareToken) },
    );
    harness.req.query.shareToken = shareToken;

    expect((await harness.invokePost()).statusCode).toBe(200);
    expect(getPreview).toHaveBeenCalledWith("link-viewer", "https://example.com");
  });

  it.each([
    ["invalid", "i".repeat(32), null],
    ["expired", "s".repeat(32), new Date(0)],
  ])("keeps share-only access closed for an %s token", async (_case, presentedToken, expiresAt) => {
    const getPreview = vi.fn(readyPreview);
    const prisma = shareOnlyPrisma("s".repeat(32), expiresAt);
    const harness = routeHarness(
      (req: any, _res: any, next: any) => {
        req.user = { id: "outsider", authCredentialType: "jwt" };
        next();
      },
      getPreview,
      { prisma },
    );
    harness.req.query.shareToken = presentedToken;

    expect((await harness.invokePost()).statusCode).toBe(404);
    expect(getPreview).not.toHaveBeenCalled();
    expect(prisma.drawingLinkShare.findFirst).toHaveBeenCalledOnce();
  });

  it("exhausts only the requesting account's time-window quota", async () => {
    const getPreview = vi.fn(async () => ({
      id: "00000000-0000-0000-0000-000000000001",
      status: "READY",
      failureCode: null,
      requestedUrl: "https://example.com",
      resolvedUrl: "https://example.com",
      title: "Example",
      description: null,
      imageBlobId: null,
      faviconBlobId: null,
    }));
    const harness = routeHarness(
      (req: any, _res: any, next: any) => {
        req.user = { id: req.headers.actor, authCredentialType: "jwt" };
        next();
      },
      getPreview,
      { authorizeDrawing: async () => true },
    );

    harness.req.headers.actor = "user-1";
    for (let request = 0; request < 12; request += 1) {
      expect((await harness.invokePost()).statusCode).toBe(200);
    }
    expect((await harness.invokePost()).statusCode).toBe(429);
    harness.req.headers.actor = "user-2";
    expect((await harness.invokePost()).statusCode).toBe(200);
    expect(getPreview).toHaveBeenCalledTimes(13);
  });

  it("uses the network address for the shared bootstrap identity", async () => {
    const getPreview = vi.fn(async () => ({
      id: "00000000-0000-0000-0000-000000000001",
      status: "READY",
      failureCode: null,
      requestedUrl: "https://example.com",
      resolvedUrl: "https://example.com",
      title: "Example",
      description: null,
      imageBlobId: null,
      faviconBlobId: null,
    }));
    const harness = routeHarness(
      (req: any, _res: any, next: any) => {
        req.user = { id: "bootstrap", authCredentialType: "bootstrap" };
        next();
      },
      getPreview,
      { authorizeDrawing: async () => true },
    );

    for (let request = 0; request < 12; request += 1) {
      expect((await harness.invokePost()).statusCode).toBe(200);
    }
    expect((await harness.invokePost()).statusCode).toBe(429);
    harness.req.ip = "198.51.100.25";
    expect((await harness.invokePost()).statusCode).toBe(200);
  });

  it("returns only local URLs for mirrored resources", async () => {
    const harness = routeHarness(
      (req: any, _res: any, next: any) => {
        req.user = { id: "user-1" };
        next();
      },
      async () => ({
        id: "00000000-0000-0000-0000-000000000001",
        status: "READY",
        failureCode: null,
        requestedUrl: "https://example.com",
        resolvedUrl: "https://example.com/final",
        title: "Example",
        description: null,
        imageBlobId: "blob-image",
        faviconBlobId: "blob-icon",
      }),
    );

    const result = await harness.invokePost();
    expect(result.body.imageUrl).toBe(
      "/api/link-previews/00000000-0000-0000-0000-000000000001/image",
    );
    expect(result.body.faviconUrl).not.toContain("example.com");
  });

  it("returns only the generic unavailable code for a cached fetch failure", async () => {
    const harness = routeHarness(
      (req: any, _res: any, next: any) => {
        req.user = { id: "user-1" };
        next();
      },
      async () => ({
        id: "00000000-0000-0000-0000-000000000002",
        status: "NEGATIVE",
        failureCode: "UNAVAILABLE",
        requestedUrl: "https://internal-name.example",
        resolvedUrl: null,
        title: null,
        description: null,
        imageBlobId: null,
        faviconBlobId: null,
      }),
    );

    const result = await harness.invokePost();
    expect(result.statusCode).toBe(422);
    expect(result.body.code).toBe("UNAVAILABLE");
    expect(JSON.stringify(result.body)).not.toContain("SSRF_BLOCKED");
    expect(JSON.stringify(result.body)).not.toContain("NETWORK_ERROR");
  });
});
