export type Emission = {
  senderId: string;
  scope: string;
  event: string;
  payload: any;
  volatile: boolean;
  excluded?: string[];
};

class FakeOperator {
  private excluded: string[] = [];

  constructor(
    private emissions: Emission[],
    private senderId: string,
    private scope: string,
    private isVolatile = false,
  ) {}

  get volatile() {
    return new FakeOperator(this.emissions, this.senderId, this.scope, true);
  }

  /** Socket.IO's own exclusion; recorded so a test can assert who was left out. */
  except(ids: string[]) {
    this.excluded = ids;
    return this;
  }

  emit(event: string, payload: any) {
    this.emissions.push({
      senderId: this.senderId,
      scope: this.scope,
      event,
      payload,
      volatile: this.isVolatile,
      // Only when there is something to say: an always-present field would
      // break every existing deep-equality assertion over an emission.
      ...(this.excluded.length ? { excluded: this.excluded } : {}),
    });
  }
}

export class FakeSocket {
  readonly handshake: {
    auth: Record<string, unknown>;
    headers: Record<string, unknown>;
    address: string;
  } = {
    auth: {},
    headers: {},
    address: "127.0.0.1",
  };
  readonly rooms: Set<string>;
  private handlers = new Map<string, (...args: any[]) => any>();

  constructor(
    readonly id: string,
    private emissions: Emission[],
  ) {
    this.rooms = new Set([id]);
  }

  get volatile() {
    return this;
  }

  on(event: string, handler: (...args: any[]) => any) {
    this.handlers.set(event, handler);
  }

  emit(event: string, payload: any) {
    this.emissions.push({ senderId: "server", scope: this.id, event, payload, volatile: false });
  }

  to(scope: string) {
    return new FakeOperator(this.emissions, this.id, scope);
  }

  async join(scope: string) {
    this.rooms.add(scope);
  }

  async leave(scope: string) {
    this.rooms.delete(scope);
  }

  disconnected = false;

  // The seam closes a connection after enough hard failures. Without this the
  // double throws instead, so a test could never tell a refusal that keeps the
  // connection from one that drops it.
  disconnect(_close?: boolean) {
    this.disconnected = true;
  }

  async trigger(event: string, ...args: any[]) {
    return await this.handlers.get(event)?.(...args);
  }
}

export class FakeIo {
  readonly emissions: Emission[] = [];
  private middleware: ((socket: FakeSocket, next: (error?: Error) => void) => any) | null = null;
  private connectionHandler: ((socket: FakeSocket) => void) | null = null;

  use(handler: any) {
    this.middleware = handler;
  }

  on(event: string, handler: any) {
    if (event === "connection") this.connectionHandler = handler;
  }

  to(scope: string) {
    return new FakeOperator(this.emissions, "io", scope);
  }

  /**
   * `auth` is what a real client passes in the handshake. Without it a test
   * cannot sign in, and a socket that cannot sign in silently becomes an
   * anonymous one -- which looks like a feature bug rather than a missing
   * argument.
   */
  async connect(id: string, auth: Record<string, unknown> = {}) {
    const socket = new FakeSocket(id, this.emissions);
    Object.assign(socket.handshake.auth, auth);
    await new Promise<void>((resolve, reject) => {
      this.middleware?.(socket, (error?: Error) => (error ? reject(error) : resolve()));
    });
    this.connectionHandler?.(socket);
    return socket;
  }
}

/**
 * Minimum realistic Prisma surface for a successful socket room join.
 *
 * Link-only tests do not otherwise need a Drawing model, but the join path
 * still sends the current board name and document-page state to the arriving
 * socket. Keep those reads explicit so a green authorization test cannot hide
 * a TypeError from either snapshot loader.
 */
export const socketJoinSnapshotPrisma = (userId = "socket-test-owner") => ({
  drawing: {
    findUnique: async () => ({
      userId,
      collectionId: null,
      name: "Socket test board",
      nameRevision: 0,
    }),
  },
  documentPageView: { findMany: async () => [] },
});

export const room = (drawingId: string) => `drawing_${drawingId}`;
