import { beforeEach, describe, expect, it } from "vitest";
import { BOOTSTRAP_USER_ID } from "../auth/authMode";
import { buildShareLinkToken, hashShareLinkToken } from "../authz/sharing";
import { FakeIo, FakeSocket, room, socketJoinSnapshotPrisma } from "../__tests__/socketTestDoubles";
import { registerSocketHandlers } from "./socket";
import { createSocketInviteHereManager } from "./socketInviteHere";

const bounds = [-100, -50, 500, 350];

const join = async (socket: FakeSocket, shareToken?: string) => {
  await socket.trigger("join-room", {
    drawingId: "drawing-1",
    shareToken,
    user: { name: "Local User", color: "#123456" },
  });
};

describe("invite here socket flow", () => {
  let io: FakeIo;

  beforeEach(() => {
    io = new FakeIo();
    registerSocketHandlers({
      io: io as any,
      prisma: {
        drawing: { findUnique: async () => ({ userId: BOOTSTRAP_USER_ID }) },
        drawingLinkShare: { findFirst: async () => null },
      } as any,
      authModeService: { getAuthEnabled: async () => false } as any,
      jwtSecret: "test-secret",
    });
  });

  it("rejects a view-only invitation at the server authorization seam", async () => {
    const viewIo = new FakeIo();
    const shareToken = buildShareLinkToken();
    registerSocketHandlers({
      io: viewIo as any,
      prisma: {
        ...socketJoinSnapshotPrisma(),
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
    const viewer = await viewIo.connect("viewer");
    await join(viewer, shareToken);
    viewIo.emissions.length = 0;

    await viewer.trigger("invite-here", { drawingId: "drawing-1", sceneBounds: bounds });

    expect(viewIo.emissions.some((item) => item.event === "invite-here")).toBe(false);
    expect(viewIo.emissions.at(-1)).toMatchObject({
      scope: "viewer",
      event: "error",
      payload: { message: expect.stringMatching(/Read-only/) },
    });
  });

  it("enforces the invitation cooldown on the server", async () => {
    const sender = await io.connect("sender");
    await join(sender);
    io.emissions.length = 0;

    await sender.trigger("invite-here", { drawingId: "drawing-1", sceneBounds: bounds });
    await sender.trigger("invite-here", {
      drawingId: "drawing-1",
      sceneBounds: [0, 0, 100, 100],
    });

    expect(io.emissions.filter((item) => item.event === "invite-here")).toHaveLength(1);
    expect(io.emissions.filter((item) => item.event === "invite-here-status")).toHaveLength(1);
  });

  it("reports only an anonymous arrived count and reveals nothing for declines", async () => {
    const sender = await io.connect("sender");
    const recipient = await io.connect("recipient");
    await join(sender);
    await join(recipient);
    io.emissions.length = 0;
    await sender.trigger("invite-here", { drawingId: "drawing-1", sceneBounds: bounds });
    const invitation = io.emissions.find((item) => item.event === "invite-here")?.payload;
    expect(invitation.inviterPresenceId).toBe("sender");
    expect(invitation.expiresAt - Date.now()).toBeGreaterThanOrEqual(14_900);
    expect(invitation.expiresAt - Date.now()).toBeLessThanOrEqual(15_000);
    const initialStatus = io.emissions.find((item) => item.event === "invite-here-status")?.payload;
    io.emissions.length = 0;

    await recipient.trigger("invite-here-response", {
      drawingId: "drawing-1",
      invitationId: invitation.invitationId,
      decision: "declined",
    });
    expect(io.emissions.filter((item) => item.event === "invite-here-status")).toEqual([]);

    await recipient.trigger("invite-here-response", {
      drawingId: "drawing-1",
      invitationId: invitation.invitationId,
      decision: "accepted",
    });
    expect(initialStatus).toEqual({
      drawingId: "drawing-1",
      invitationId: invitation.invitationId,
      expiresAt: invitation.expiresAt,
      arrivedCount: 0,
    });
    expect(io.emissions).toEqual([
      {
        senderId: "server",
        scope: "sender",
        event: "invite-here-status",
        payload: {
          drawingId: "drawing-1",
          invitationId: invitation.invitationId,
          expiresAt: invitation.expiresAt,
          arrivedCount: 1,
        },
        volatile: false,
      },
    ]);
    expect(Object.values(io.emissions[0]!.payload)).not.toContain("recipient");
    expect(io.emissions.some((item) => item.scope === room("drawing-1"))).toBe(false);
  });

  it("counts two accepted tabs of the same account as one arrival", async () => {
    const sockets = ["sender", "recipient-one", "recipient-two"].map(
      (id) => new FakeSocket(id, io.emissions),
    );
    const connectedSockets = new Map(sockets.map((socket) => [socket.id, socket as any]));
    const manager = createSocketInviteHereManager({
      connectedSockets,
      getPresence: (socketId) => ({
        presenceId: socketId,
        accountId: socketId === "sender" ? "inviter-account" : "recipient-account",
        name: socketId,
        initials: "T",
        color: "#123456",
        kind: "member",
        isActive: true,
        selectedElementIds: {},
      }),
      requireAccess: async () => true,
    });
    for (const socket of sockets) manager.registerHandlers(socket as any);

    await sockets[0].trigger("invite-here", { drawingId: "drawing-1", sceneBounds: bounds });
    const invitation = io.emissions.find((item) => item.event === "invite-here")?.payload;
    io.emissions.length = 0;
    for (const recipient of sockets.slice(1)) {
      await recipient.trigger("invite-here-response", {
        drawingId: "drawing-1",
        invitationId: invitation.invitationId,
        decision: "accepted",
      });
    }

    expect(io.emissions).toEqual([
      expect.objectContaining({
        scope: "sender",
        event: "invite-here-status",
        payload: expect.objectContaining({ arrivedCount: 1 }),
      }),
    ]);
    expect(Object.keys(io.emissions[0]!.payload)).toEqual([
      "drawingId",
      "invitationId",
      "expiresAt",
      "arrivedCount",
    ]);
  });
});
