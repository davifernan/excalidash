import { describe, expect, it, vi } from "vitest";
import { buildShareLinkToken, hashShareLinkToken } from "../authz/sharing";
import { socketJoinSnapshotPrisma } from "../__tests__/socketTestDoubles";
import { registerSocketHandlers } from "./socket";

type Emission = { scope: string; event: string; payload: any };

class FakeOperator {
  constructor(
    private emissions: Emission[],
    private scope: string,
  ) {}
  get volatile() {
    return this;
  }
  emit(event: string, payload: any) {
    this.emissions.push({ scope: this.scope, event, payload });
  }
}

class FakeSocket {
  readonly handshake = { auth: {}, headers: {} };
  readonly rooms = new Set<string>([this.id]);
  private handlers = new Map<string, (...args: any[]) => any>();
  constructor(
    readonly id: string,
    private emissions: Emission[],
  ) {}
  get volatile() {
    return this;
  }
  on(event: string, handler: (...args: any[]) => any) {
    this.handlers.set(event, handler);
  }
  emit(event: string, payload: any) {
    this.emissions.push({ scope: this.id, event, payload });
  }
  to(scope: string) {
    return new FakeOperator(this.emissions, scope);
  }
  async join(scope: string) {
    this.rooms.add(scope);
  }
  async leave(scope: string) {
    this.rooms.delete(scope);
  }
  async trigger(event: string, ...args: any[]) {
    return this.handlers.get(event)?.(...args);
  }
}

class FakeIo {
  readonly emissions: Emission[] = [];
  private middleware: any;
  private connectionHandler: any;
  use(handler: any) {
    this.middleware = handler;
  }
  on(event: string, handler: any) {
    if (event === "connection") this.connectionHandler = handler;
  }
  to(scope: string) {
    return new FakeOperator(this.emissions, scope);
  }
  async connect(id: string) {
    const socket = new FakeSocket(id, this.emissions);
    await new Promise<void>((resolve, reject) => {
      this.middleware(socket, (error?: Error) => (error ? reject(error) : resolve()));
    });
    await this.connectionHandler(socket);
    return socket;
  }
}

describe("periodic socket access sweep", () => {
  it("does not overlap sweeps while evicting many passive viewers", async () => {
    const io = new FakeIo();
    const shareToken = buildShareLinkToken();
    let linkActive = true;
    let blockSweeps = false;
    let blockedLookups = 0;
    let releaseSweep: (() => void) | undefined;
    const sweepBarrier = new Promise<void>((resolve) => {
      releaseSweep = resolve;
    });
    registerSocketHandlers({
      io: io as any,
      prisma: {
        ...socketJoinSnapshotPrisma(),
        drawingLinkShare: {
          findFirst: vi.fn(async () => {
            if (blockSweeps) {
              blockedLookups += 1;
              await sweepBarrier;
            }
            return linkActive
              ? { permission: "view", tokenHash: hashShareLinkToken(shareToken) }
              : null;
          }),
        },
      } as any,
      authModeService: { getAuthEnabled: async () => true } as any,
      jwtSecret: "test-secret",
      accessRecheckIntervalMs: 5,
    });
    const viewers = await Promise.all(
      Array.from({ length: 24 }, (_, index) => io.connect(`viewer-${index}`)),
    );
    await Promise.all(
      viewers.map((viewer) =>
        viewer.trigger("join-room", { drawingId: "drawing-1", shareToken, user: {} }),
      ),
    );
    expect(viewers.every((viewer) => viewer.rooms.has("drawing_drawing-1"))).toBe(true);

    blockSweeps = true;
    await vi.waitFor(() => expect(blockedLookups).toBe(24), {
      timeout: 200,
      interval: 5,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(blockedLookups).toBe(24);

    linkActive = false;
    releaseSweep?.();
    await vi.waitFor(
      () => expect(viewers.every((viewer) => !viewer.rooms.has("drawing_drawing-1"))).toBe(true),
      { timeout: 200, interval: 5 },
    );
    expect(io.emissions.filter((item) => item.event === "presence-update").at(-1)).toMatchObject({
      payload: [],
    });
  });
});
