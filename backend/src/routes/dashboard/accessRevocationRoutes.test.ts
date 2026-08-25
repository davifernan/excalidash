import express from "express";
import { describe, expect, it, vi } from "vitest";
import { generateApiKey, serializeApiKeyScopes } from "../../auth/apiKeys";
import { registerSocketHandlers } from "../../server/socket";
import { registerCollectionRoutes } from "./collections";
import { registerDrawingDeleteDuplicateRoutes } from "./drawingDeleteDuplicateRoutes";
import { registerDrawingSharingRoutes } from "./drawingSharingRoutes";

class FakeOperator {
  constructor(
    private events: any[],
    private scope: string,
  ) {}
  get volatile() {
    return this;
  }
  except() {
    return this;
  }
  emit(event: string, payload: any) {
    this.events.push({ scope: this.scope, event, payload });
  }
}

class FakeSocket {
  readonly rooms = new Set([this.id]);
  readonly handshake: any;
  readonly disconnect = vi.fn();
  private handlers = new Map<string, (...args: any[]) => any>();
  constructor(
    readonly id: string,
    private events: any[],
    token?: string,
  ) {
    this.handshake = { auth: token ? { token } : {}, headers: {} };
  }
  get volatile() {
    return this;
  }
  on(event: string, handler: (...args: any[]) => any) {
    this.handlers.set(event, handler);
  }
  emit(event: string, payload: any) {
    this.events.push({ scope: this.id, event, payload });
  }
  to(scope: string) {
    return new FakeOperator(this.events, scope);
  }
  async join(scope: string) {
    this.rooms.add(scope);
  }
  async leave(scope: string) {
    this.rooms.delete(scope);
  }
  trigger(event: string, ...args: any[]) {
    return this.handlers.get(event)?.(...args);
  }
}

class FakeIo {
  readonly events: any[] = [];
  private middleware: any;
  private onConnection: any;
  use(handler: any) {
    this.middleware = handler;
  }
  on(event: string, handler: any) {
    if (event === "connection") this.onConnection = handler;
  }
  to(scope: string) {
    return new FakeOperator(this.events, scope);
  }
  async connect(id: string, token?: string) {
    const socket = new FakeSocket(id, this.events, token);
    await new Promise<void>((resolve, reject) => {
      this.middleware(socket, (error?: Error) => (error ? reject(error) : resolve()));
    });
    this.onConnection(socket);
    return socket;
  }
}

const asyncHandler = (handler: any) => async (req: any, res: any, next: any) => {
  try {
    await handler(req, res, next);
  } catch (error) {
    next(error);
  }
};

const requireAuth = (req: any, _res: any, next: any) => {
  req.user = { id: "owner" };
  next();
};

const invokeDeleteRoute = async (
  app: express.Express,
  path: string,
  params: Record<string, string>,
) => {
  const layer = (app as any).router.stack.find(
    (candidate: any) => candidate.route?.path === path && candidate.route.methods.delete,
  );
  const req: any = { params, body: {}, headers: {}, connection: {} };
  const res: any = {
    statusCode: 200,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.payload = payload;
      return this;
    },
  };
  for (const handlerLayer of layer.route.stack) {
    await handlerLayer.handle(req, res, () => undefined);
  }
  return res;
};

const createHarness = async () => {
  let drawingExists = true;
  let directShare = true;
  let collectionShare = true;
  let publicLink = true;
  const viewerKey = generateApiKey();
  const ownerKey = generateApiKey();
  const keyRows = new Map([
    [viewerKey.keyId, { id: "viewer-key", token: viewerKey, userId: "viewer" }],
    [ownerKey.keyId, { id: "owner-key", token: ownerKey, userId: "owner" }],
  ]);
  const prisma: any = {
    apiKey: {
      findUnique: vi.fn(async ({ where }: any) => {
        const entry = where.keyId
          ? keyRows.get(where.keyId)
          : Array.from(keyRows.values()).find((candidate) => candidate.id === where.id);
        return entry
          ? {
              id: entry.id,
              keyId: entry.token.keyId,
              tokenHash: entry.token.tokenHash,
              scopes: serializeApiKeyScopes(),
              revokedAt: null,
              user: { id: entry.userId, isActive: true },
            }
          : null;
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    // isActive matters now: the access lookup re-reads the account, and a
    // fixture without the flag makes every principal read as deactivated.
    user: { findUnique: vi.fn(async ({ where }: any) => ({ name: where.id, isActive: true })) },
    drawing: {
      findUnique: vi.fn(async () =>
        drawingExists
          ? {
              id: "drawing-1",
              userId: "owner",
              collectionId: "collection-1",
              name: "Board",
              nameRevision: 0,
            }
          : null,
      ),
      findFirst: vi.fn(async () =>
        drawingExists
          ? { id: "drawing-1", userId: "owner", collectionId: "collection-1", name: "Board" }
          : null,
      ),
      // The sharing routes now ask who controls the board, which is a batched
      // question: the drawing row, then each possible claim on it.
      findMany: vi.fn(async () =>
        drawingExists ? [{ id: "drawing-1", userId: "owner", collectionId: "collection-1" }] : [],
      ),
      updateMany: vi.fn(async () => ({ count: drawingExists ? 1 : 0 })),
      deleteMany: vi.fn(async () => {
        if (!drawingExists) return { count: 0 };
        drawingExists = false;
        return { count: 1 };
      }),
    },
    drawingPermission: {
      findUnique: vi.fn(async ({ where }: any) =>
        directShare && where.drawingId_granteeUserId.granteeUserId === "viewer"
          ? { permission: "view" }
          : null,
      ),
      findFirst: vi.fn(async () => (directShare ? { granteeUserId: "viewer" } : null)),
      findMany: vi.fn(async ({ where }: any) =>
        directShare && where.granteeUserId === "viewer"
          ? [{ drawingId: "drawing-1", permission: "view" }]
          : [],
      ),
      deleteMany: vi.fn(async () => {
        const count = directShare ? 1 : 0;
        directShare = false;
        return { count };
      }),
    },
    collection: {
      findFirst: vi.fn(async ({ where }: any) => {
        if (where.userId === "owner") return { id: "collection-1", name: "Shared" };
        return null;
      }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn(async ({ where }: any) =>
        where.userId === "owner" ? [{ id: "collection-1" }] : [],
      ),
    },
    collectionShare: {
      findFirst: vi.fn(async ({ where }: any) =>
        collectionShare && where.granteeUserId === "viewer" ? { role: "view" } : null,
      ),
      findMany: vi.fn(async ({ where }: any) => {
        if (!collectionShare) return [];
        // Two callers, two shapes: the membership lookup asks about one person,
        // the revocation path asks who is affected.
        if (where.granteeUserId) {
          return where.granteeUserId === "viewer"
            ? [{ collectionId: "collection-1", role: "view" }]
            : [];
        }
        return [{ granteeUserId: "viewer" }];
      }),
      deleteMany: vi.fn(async () => {
        const count = collectionShare ? 1 : 0;
        collectionShare = false;
        return { count };
      }),
    },
    drawingLinkShare: {
      findFirst: vi.fn(async () => (publicLink ? { permission: "view" } : null)),
      updateMany: vi.fn(async () => {
        const count = publicLink ? 1 : 0;
        publicLink = false;
        return { count };
      }),
    },
    documentPageView: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn(async (operation: Promise<unknown>[] | ((tx: any) => unknown)) =>
      typeof operation === "function" ? operation(prisma) : Promise.all(operation),
    ),
  };
  const io = new FakeIo();
  const collaborationAccess = registerSocketHandlers({
    io: io as any,
    prisma,
    authModeService: { getAuthEnabled: async () => true } as any,
    jwtSecret: "test-secret",
  });
  const viewer = await io.connect("viewer-socket", viewerKey.token);
  const owner = await io.connect("owner-socket", ownerKey.token);
  const join = (socket: FakeSocket) =>
    socket.trigger("join-room", { drawingId: "drawing-1", user: { name: socket.id } });
  await Promise.all([join(viewer), join(owner)]);
  expect(viewer.rooms.has("drawing_drawing-1")).toBe(true);
  expect(owner.rooms.has("drawing_drawing-1")).toBe(true);
  const baseDeps = {
    prisma,
    requireAuth,
    asyncHandler,
    invalidateDrawingsCache: vi.fn(),
    collaborationAccess,
    config: { enableAuditLogging: false },
    logAuditEvent: vi.fn(),
  };
  return {
    prisma,
    io,
    viewer,
    owner,
    join,
    collaborationAccess,
    baseDeps,
    disableDirectShare: () => {
      directShare = false;
    },
    disableCollectionShare: () => {
      collectionShare = false;
    },
    disablePublicLink: () => {
      publicLink = false;
    },
  };
};

describe("sharing route collaboration revocation", () => {
  it("evicts the affected drawing grantee and retains the owner", async () => {
    const harness = await createHarness();
    harness.disablePublicLink();
    harness.disableCollectionShare();
    const app = express();
    registerDrawingSharingRoutes(app, harness.baseDeps as any);

    const response = await invokeDeleteRoute(app, "/drawings/:id/permissions/:permId", {
      id: "drawing-1",
      permId: "permission-1",
    });

    expect(response.statusCode).toBe(200);
    expect(harness.viewer.rooms.has("drawing_drawing-1")).toBe(false);
    expect(harness.owner.rooms.has("drawing_drawing-1")).toBe(true);
  });

  it("evicts an anonymous passive viewer after public-link revocation", async () => {
    const harness = await createHarness();
    harness.disableDirectShare();
    harness.disableCollectionShare();
    const anonymous = await harness.io.connect("anonymous");
    await harness.join(anonymous);
    const app = express();
    registerDrawingSharingRoutes(app, harness.baseDeps as any);

    const response = await invokeDeleteRoute(app, "/drawings/:id/link-shares/:shareId", {
      id: "drawing-1",
      shareId: "link-1",
    });

    expect(response.statusCode).toBe(200);
    expect(anonymous.rooms.has("drawing_drawing-1")).toBe(false);
    expect(harness.owner.rooms.has("drawing_drawing-1")).toBe(true);
  });

  it("evicts former collection grantees when the collection is deleted", async () => {
    const harness = await createHarness();
    harness.disableDirectShare();
    harness.disablePublicLink();
    const app = express();
    registerCollectionRoutes(app, harness.baseDeps as any);

    const response = await invokeDeleteRoute(app, "/collections/:id", { id: "collection-1" });

    expect(response.statusCode).toBe(200);
    expect(harness.viewer.rooms.has("drawing_drawing-1")).toBe(false);
    expect(harness.owner.rooms.has("drawing_drawing-1")).toBe(true);
  });

  it("evicts every socket from a drawing after the drawing is deleted", async () => {
    const harness = await createHarness();
    const app = express();
    registerDrawingDeleteDuplicateRoutes(app, {
      ...harness.baseDeps,
      cleanupS3FilesForDrawing: vi.fn(),
      cloneS3FileReferences: vi.fn(),
      ensureTrashCollection: vi.fn(),
      parseJsonField: vi.fn(),
    } as any);

    const response = await invokeDeleteRoute(app, "/drawings/:id", { id: "drawing-1" });

    expect(response.statusCode).toBe(200);
    expect(harness.viewer.rooms.has("drawing_drawing-1")).toBe(false);
    expect(harness.owner.rooms.has("drawing_drawing-1")).toBe(false);
  });
});
