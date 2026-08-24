import { describe, expect, it, vi } from "vitest";
import { BOOTSTRAP_USER_ID } from "../auth/authMode";
import { buildShareLinkToken, hashShareLinkToken } from "../authz/sharing";
import { FakeIo, FakeSocket, room } from "../__tests__/socketTestDoubles";
import { registerSocketHandlers } from "./socket";
import { PresenterRegistry } from "./presenterRegistry";
import {
  createSocketPresenterManager,
  PRESENTER_COMMAND_EVENT,
  PRESENTER_NOTES_EVENT,
  PRESENTER_NOTES_SET_EVENT,
  PRESENTER_STATE_EVENT,
  PRESENTER_VIEWPORT_EVENT,
} from "./socketPresenter";

const stateEmissions = (io: FakeIo) =>
  io.emissions.filter((emission) => emission.event === PRESENTER_STATE_EVENT);

describe("presenter command authorization (isolated manager)", () => {
  const setup = (access: unknown) => {
    const io = new FakeIo();
    const socket = new FakeSocket("presenter-socket", io.emissions);
    socket.rooms.add(room("drawing-1"));
    const presenters = new PresenterRegistry();
    const requireAccess = vi.fn().mockResolvedValue(access);
    const manager = createSocketPresenterManager({
      io: io as any,
      presenters,
      getPresence: () => ({ name: "Ada" }) as any,
      requireAccess,
    });
    manager.registerHandlers(
      socket as any,
      () => true,
      () => true,
    );
    return { io, socket, presenters, requireAccess };
  };

  it("rejects start without edit access", async () => {
    const { socket, presenters, io } = setup(null);
    const acks: unknown[] = [];
    await socket.trigger(
      PRESENTER_COMMAND_EVENT,
      { drawingId: "drawing-1", action: "start" },
      (value: unknown) => acks.push(value),
    );
    expect(presenters.snapshot("drawing-1").status).toBe("idle");
    expect(acks).toEqual([
      { ok: false, error: { code: "access-denied", message: expect.any(String) } },
    ]);
    expect(stateEmissions(io)).toHaveLength(0);
  });

  it("lets an editor start presenting and broadcasts to the room", async () => {
    const { socket, presenters, io } = setup("edit");
    const acks: unknown[] = [];
    await socket.trigger(
      PRESENTER_COMMAND_EVENT,
      { drawingId: "drawing-1", action: "start" },
      (value: unknown) => acks.push(value),
    );
    expect(acks).toEqual([{ ok: true }]);
    expect(presenters.isPresenter("drawing-1", "presenter-socket")).toBe(true);
    expect(stateEmissions(io)).toMatchObject([
      { scope: room("drawing-1"), payload: { status: "presenting", presenterName: "Ada" } },
    ]);
  });

  it("rejects takeover from a non-owner editor", async () => {
    const { socket, io } = setup("edit");
    const acks: unknown[] = [];
    await socket.trigger(
      PRESENTER_COMMAND_EVENT,
      { drawingId: "drawing-1", action: "takeover" },
      (value: unknown) => acks.push(value),
    );
    expect(acks).toEqual([
      { ok: false, error: { code: "forbidden", message: expect.any(String) } },
    ]);
    expect(stateEmissions(io)).toHaveLength(0);
  });

  it("lets the owner take over from an active presenter", async () => {
    const io = new FakeIo();
    const presenters = new PresenterRegistry();
    presenters.start("drawing-1", "other-socket", "Bea");
    const socket = new FakeSocket("owner-socket", io.emissions);
    socket.rooms.add(room("drawing-1"));
    const manager = createSocketPresenterManager({
      io: io as any,
      presenters,
      getPresence: () => ({ name: "Owner" }) as any,
      requireAccess: vi.fn().mockResolvedValue("owner"),
    });
    manager.registerHandlers(
      socket as any,
      () => true,
      () => true,
    );

    const acks: unknown[] = [];
    await socket.trigger(
      PRESENTER_COMMAND_EVENT,
      { drawingId: "drawing-1", action: "takeover" },
      (value: unknown) => acks.push(value),
    );

    expect(acks).toEqual([{ ok: true }]);
    expect(presenters.isPresenter("drawing-1", "owner-socket")).toBe(true);
    expect(presenters.isPresenter("drawing-1", "other-socket")).toBe(false);
  });

  it("does not let a second editor start while one is already presenting", async () => {
    const io = new FakeIo();
    const presenters = new PresenterRegistry();
    presenters.start("drawing-1", "first-socket", "Ada");
    const socket = new FakeSocket("second-socket", io.emissions);
    socket.rooms.add(room("drawing-1"));
    const manager = createSocketPresenterManager({
      io: io as any,
      presenters,
      getPresence: () => ({ name: "Bea" }) as any,
      requireAccess: vi.fn().mockResolvedValue("edit"),
    });
    manager.registerHandlers(
      socket as any,
      () => true,
      () => true,
    );

    const acks: unknown[] = [];
    await socket.trigger(
      PRESENTER_COMMAND_EVENT,
      { drawingId: "drawing-1", action: "start" },
      (value: unknown) => acks.push(value),
    );
    expect(acks).toEqual([
      { ok: false, error: { code: "presenter-active", message: expect.any(String) } },
    ]);
  });

  it("routes a named frame jump non-volatile and a freeform pan volatile", async () => {
    const { socket, io } = setup("edit");
    await socket.trigger(PRESENTER_COMMAND_EVENT, { drawingId: "drawing-1", action: "start" });
    io.emissions.length = 0;

    await socket.trigger(PRESENTER_VIEWPORT_EVENT, {
      drawingId: "drawing-1",
      frameId: "frame-1",
      sceneBounds: [0, 0, 10, 10],
    });
    await socket.trigger(PRESENTER_VIEWPORT_EVENT, {
      drawingId: "drawing-1",
      frameId: null,
      sceneBounds: [1, 1, 11, 11],
    });

    const emissions = stateEmissions(io);
    expect(emissions).toHaveLength(2);
    expect(emissions[0]).toMatchObject({ volatile: false, payload: { frameId: "frame-1" } });
    expect(emissions[1]).toMatchObject({ volatile: true, payload: { frameId: null } });
  });

  it("ignores a viewport update from a socket that is not the presenter", async () => {
    const { io, presenters, requireAccess } = setup("edit");
    requireAccess.mockResolvedValue("edit");
    const bystander = new FakeSocket("bystander", io.emissions);
    bystander.rooms.add(room("drawing-1"));
    const manager = createSocketPresenterManager({
      io: io as any,
      presenters,
      getPresence: () => ({ name: "Bystander" }) as any,
      requireAccess,
    });
    manager.registerHandlers(
      bystander as any,
      () => true,
      () => true,
    );

    await bystander.trigger(PRESENTER_VIEWPORT_EVENT, {
      drawingId: "drawing-1",
      frameId: "frame-1",
      sceneBounds: [0, 0, 10, 10],
    });
    expect(stateEmissions(io)).toHaveLength(0);
  });

  it("pushes the current frame's notes to the presenter only, on start and on advance", async () => {
    const { socket, io } = setup("edit");
    await socket.trigger(PRESENTER_COMMAND_EVENT, { drawingId: "drawing-1", action: "start" });
    const notesOnStart = io.emissions.filter((e) => e.event === PRESENTER_NOTES_EVENT);
    expect(notesOnStart).toHaveLength(1);
    expect(notesOnStart[0]).toMatchObject({
      scope: "presenter-socket",
      payload: { frameId: null, text: "" },
    });

    await socket.trigger(PRESENTER_NOTES_SET_EVENT, {
      drawingId: "drawing-1",
      frameId: "frame-1",
      text: "Ask about budget",
    });
    await socket.trigger(PRESENTER_VIEWPORT_EVENT, {
      drawingId: "drawing-1",
      frameId: "frame-1",
      sceneBounds: [0, 0, 10, 10],
    });

    const notesOnAdvance = io.emissions.filter((e) => e.event === PRESENTER_NOTES_EVENT);
    expect(notesOnAdvance.at(-1)).toMatchObject({
      scope: "presenter-socket",
      payload: { frameId: "frame-1", text: "Ask about budget" },
    });
    // Notes never appear on the room-broadcast channel.
    expect(stateEmissions(io).some((e) => "text" in (e.payload || {}))).toBe(false);
  });

  it("refuses to let a non-presenting editor read or write notes", async () => {
    const io = new FakeIo();
    const presenters = new PresenterRegistry();
    presenters.start("drawing-1", "other-socket", "Ada");
    const socket = new FakeSocket("bystander", io.emissions);
    socket.rooms.add(room("drawing-1"));
    const manager = createSocketPresenterManager({
      io: io as any,
      presenters,
      getPresence: () => ({ name: "Bystander" }) as any,
      requireAccess: vi.fn().mockResolvedValue("edit"),
    });
    manager.registerHandlers(
      socket as any,
      () => true,
      () => true,
    );
    const acks: unknown[] = [];
    await socket.trigger(
      PRESENTER_NOTES_SET_EVENT,
      { drawingId: "drawing-1", frameId: null, text: "sneaky" },
      (value: unknown) => acks.push(value),
    );
    expect(acks).toEqual([
      { ok: false, error: { code: "not-presenting", message: expect.any(String) } },
    ]);
    expect(presenters.getNotes("drawing-1", null)).toBe("");
  });
});

describe("presenter wiring inside the real socket server", () => {
  const ownerSetup = () => {
    const io = new FakeIo();
    registerSocketHandlers({
      io: io as any,
      prisma: {
        drawing: { findUnique: async () => ({ userId: BOOTSTRAP_USER_ID }) },
        drawingLinkShare: { findFirst: async () => null },
      } as any,
      authModeService: { getAuthEnabled: async () => false } as any,
      jwtSecret: "test-secret",
    });
    return io;
  };

  const join = async (socket: FakeSocket, shareToken?: string) => {
    let acknowledgement: any;
    await socket.trigger(
      "join-room",
      { drawingId: "drawing-1", shareToken, user: { name: "Workshop User" } },
      (value: unknown) => {
        acknowledgement = value;
      },
    );
    return acknowledgement;
  };

  it("pushes the current presenter snapshot to someone joining mid-presentation", async () => {
    const io = ownerSetup();
    const presenter = await io.connect("presenter");
    expect((await join(presenter))?.ok).toBe(true);
    await presenter.trigger(PRESENTER_COMMAND_EVENT, { drawingId: "drawing-1", action: "start" });

    const latecomer = await io.connect("latecomer");
    await join(latecomer);

    const pushedToLatecomer = io.emissions.find(
      (emission) => emission.event === PRESENTER_STATE_EVENT && emission.scope === "latecomer",
    );
    expect(pushedToLatecomer?.payload).toMatchObject({ status: "presenting" });
    await presenter.trigger("disconnect");
    await latecomer.trigger("disconnect");
  });

  it("ends presenting when the presenter's socket really disconnects", async () => {
    const io = ownerSetup();
    const presenter = await io.connect("presenter");
    await join(presenter);
    await presenter.trigger(PRESENTER_COMMAND_EVENT, { drawingId: "drawing-1", action: "start" });
    io.emissions.length = 0;

    await presenter.trigger("disconnect");

    expect(stateEmissions(io).at(-1)).toMatchObject({ payload: { status: "idle" } });
  });

  it("does not end presenting when the presenter only goes tab-inactive", async () => {
    // Presenting rides the same connection lifecycle as presence: an
    // inactive tab never calls removeFromDrawing, so this is really asserting
    // that nothing about presenting is wired to `user-activity` at all --
    // the exact confusion docs/product/COLLABORATION_NAVIGATION.md documents
    // for Follow (isActive: false is a focus loss, not a disconnect).
    const io = ownerSetup();
    const presenter = await io.connect("presenter");
    await join(presenter);
    await presenter.trigger(PRESENTER_COMMAND_EVENT, { drawingId: "drawing-1", action: "start" });
    io.emissions.length = 0;

    await presenter.trigger("user-activity", { drawingId: "drawing-1", isActive: false });

    expect(stateEmissions(io)).toHaveLength(0);
  });

  it("does not let a view-only link participant start presenting", async () => {
    const io = new FakeIo();
    const shareToken = buildShareLinkToken();
    registerSocketHandlers({
      io: io as any,
      prisma: {
        drawingLinkShare: {
          findFirst: async () => ({
            permission: "view",
            tokenHash: hashShareLinkToken(shareToken),
          }),
        },
      } as any,
      authModeService: { getAuthEnabled: async () => true } as any,
      jwtSecret: "test-secret",
    });
    const viewer = await io.connect("viewer");
    expect((await join(viewer, shareToken))?.ok).toBe(true);
    io.emissions.length = 0;

    await viewer.trigger(PRESENTER_COMMAND_EVENT, { drawingId: "drawing-1", action: "start" });

    expect(stateEmissions(io)).toHaveLength(0);
    expect(io.emissions.find((emission) => emission.event === "error")).toMatchObject({
      scope: "viewer",
      payload: { message: "Read-only access: cannot edit this drawing" },
    });
  });
});
