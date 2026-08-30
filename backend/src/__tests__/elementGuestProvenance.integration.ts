import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../generated/client";
import request from "supertest";
import jwt, { type SignOptions } from "jsonwebtoken";
import type { StringValue } from "ms";
import { registerAgentContext } from "../agent/boardContexts";
import {
  confirmElementGuestProvenance,
  ElementGuestProvenanceConflictError,
  readElementGuestProvenance,
  recordSuccessfulElementMutation,
} from "../agent/elementGuestProvenance";
import { getTestPrisma, setupTestDb } from "./testUtils";
import { buildShareLinkToken, hashShareLinkToken } from "../authz/sharing";
import { config } from "../config";
import { FakeIo } from "./socketTestDoubles";
import { registerSocketHandlers } from "../server/socket";
import * as drawingCapabilities from "../authz/capabilities";

const frame = {
  id: "frame-1",
  type: "frame",
  x: 0,
  y: 0,
  width: 400,
  height: 300,
  angle: 0,
  isDeleted: false,
};

const note = (overrides: Record<string, unknown> = {}) => ({
  id: "note-1",
  type: "text",
  text: "Initial note",
  x: 20,
  y: 20,
  width: 120,
  height: 40,
  frameId: null,
  version: 1,
  isDeleted: false,
  ...overrides,
});

describe("element guest provenance (NIL-695)", () => {
  let prisma: PrismaClient;
  let drawingId: string;
  let app: any;
  let owner: { id: string; email: string };
  let stranger: { id: string; email: string };

  const sign = (user: { id: string; email: string }) => {
    const options: SignOptions = { expiresIn: config.jwtAccessExpiresIn as StringValue };
    return jwt.sign(
      { userId: user.id, email: user.email, type: "access" },
      config.jwtSecret,
      options,
    );
  };

  beforeAll(async () => {
    setupTestDb();
    prisma = getTestPrisma();
    ({ app } = await import("../index"));
    await prisma.systemConfig.upsert({
      where: { id: "default" },
      update: { authEnabled: true, registrationEnabled: false },
      create: { id: "default", authEnabled: true, registrationEnabled: false },
    });
    owner = await prisma.user.create({
      data: {
        email: "nil695-owner@test.local",
        passwordHash: "not-used",
        name: "Owner",
      },
      select: { id: true, email: true },
    });
    stranger = await prisma.user.create({
      data: {
        email: "nil695-stranger@test.local",
        passwordHash: "not-used",
        name: "Guest account",
      },
      select: { id: true, email: true },
    });
    drawingId = (
      await prisma.drawing.create({
        data: {
          name: "Provenance board",
          elements: JSON.stringify([
            frame,
            note(),
            { ...note({ id: "legacy-in-frame" }), frameId: frame.id },
          ]),
          appState: "{}",
          files: "{}",
          userId: owner.id,
        },
      })
    ).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("keeps absence unknown until registration conservatively fixes the existing frame as guest-touched", async () => {
    expect(
      await readElementGuestProvenance(prisma, drawingId, ["legacy-in-frame", "note-1"]),
    ).toEqual([
      { elementId: "legacy-in-frame", status: "unknown" },
      { elementId: "note-1", status: "unknown" },
    ]);

    const registered = await registerAgentContext({
      prisma,
      drawingId,
      frameElementId: frame.id,
    });

    expect(registered.provenanceReview).toEqual({
      confirmationRequired: true,
      elementIdsRequiringConfirmation: ["frame-1", "legacy-in-frame"],
    });
    expect(await readElementGuestProvenance(prisma, drawingId, ["legacy-in-frame"])).toEqual([
      { elementId: "legacy-in-frame", status: "guest-touched" },
    ]);
    expect(await readElementGuestProvenance(prisma, drawingId, ["note-1"])).toEqual([
      { elementId: "note-1", status: "unknown" },
    ]);
  });

  it("does not invent clean provenance when history restore reintroduces an unknown element", async () => {
    const restoreFrame = { ...frame, id: "restore-frame" };
    const drawing = await prisma.drawing.create({
      data: {
        name: "Historical provenance board",
        elements: JSON.stringify([restoreFrame]),
        appState: "{}",
        files: "{}",
        userId: owner.id,
      },
    });
    await registerAgentContext({
      prisma,
      drawingId: drawing.id,
      frameElementId: restoreFrame.id,
    });
    const historicalElement = note({
      id: "historical-unknown",
      frameId: restoreFrame.id,
    });
    const snapshot = await prisma.drawingSnapshot.create({
      data: {
        drawingId: drawing.id,
        version: drawing.version,
        elements: JSON.stringify([restoreFrame, historicalElement]),
        appState: "{}",
        files: "{}",
      },
    });
    const ownerAgent = request.agent(app);
    const csrf = await ownerAgent.get("/csrf-token").set("User-Agent", "nil695-test");

    const restored = await ownerAgent
      .post(`/drawings/${drawing.id}/history/${snapshot.id}/restore`)
      .set("User-Agent", "nil695-test")
      .set("Authorization", `Bearer ${sign(owner)}`)
      .set(csrf.body.header, csrf.body.token);

    expect(restored.status).toBe(200);
    expect(await readElementGuestProvenance(prisma, drawing.id, ["historical-unknown"])).toEqual([
      { elementId: "historical-unknown", status: "unknown" },
    ]);
  });

  it("never washes a guest-touched element through later member mutations", async () => {
    await recordSuccessfulElementMutation({
      prisma,
      drawingId,
      isGuest: true,
      changedElementIds: ["note-1"],
      createdElementIds: [],
    });

    for (const memberMutation of [
      { changedElementIds: ["note-1"], createdElementIds: [] },
      { changedElementIds: ["note-1"], createdElementIds: [] },
      { changedElementIds: ["note-1"], createdElementIds: [] },
    ]) {
      await recordSuccessfulElementMutation({
        prisma,
        drawingId,
        isGuest: false,
        ...memberMutation,
      });
    }

    expect(await readElementGuestProvenance(prisma, drawingId, ["note-1"])).toEqual([
      { elementId: "note-1", status: "guest-touched" },
    ]);

    await recordSuccessfulElementMutation({
      prisma,
      drawingId,
      isGuest: false,
      changedElementIds: ["member-created"],
      createdElementIds: ["member-created"],
    });
    expect(await readElementGuestProvenance(prisma, drawingId, ["member-created"])).toEqual([
      { elementId: "member-created", status: "confirmed-clean" },
    ]);
  });

  it("distinguishes explicit confirmation from unknown and lets a later guest touch win", async () => {
    await confirmElementGuestProvenance(prisma, drawingId, ["legacy-in-frame"]);
    expect(
      await readElementGuestProvenance(prisma, drawingId, ["legacy-in-frame", "never-seen"]),
    ).toEqual([
      { elementId: "legacy-in-frame", status: "confirmed-clean" },
      { elementId: "never-seen", status: "unknown" },
    ]);

    await recordSuccessfulElementMutation({
      prisma,
      drawingId,
      isGuest: true,
      changedElementIds: ["legacy-in-frame"],
      createdElementIds: [],
    });
    expect(await readElementGuestProvenance(prisma, drawingId, ["legacy-in-frame"])).toEqual([
      { elementId: "legacy-in-frame", status: "guest-touched" },
    ]);
  });

  it("does not let a stale confirmation erase a concurrent guest touch", async () => {
    await recordSuccessfulElementMutation({
      prisma,
      drawingId,
      isGuest: true,
      changedElementIds: ["confirmation-race"],
      createdElementIds: [],
    });
    const racePrisma = {
      drawingElementGuestProvenance: {
        findMany: (args: unknown) => prisma.drawingElementGuestProvenance.findMany(args as any),
      },
      $executeRaw: async (query: any) => {
        await recordSuccessfulElementMutation({
          prisma,
          drawingId,
          isGuest: true,
          changedElementIds: ["confirmation-race"],
          createdElementIds: [],
        });
        return prisma.$executeRaw(query);
      },
    };

    await expect(
      confirmElementGuestProvenance(racePrisma, drawingId, ["confirmation-race"]),
    ).rejects.toBeInstanceOf(ElementGuestProvenanceConflictError);
    expect(await readElementGuestProvenance(prisma, drawingId, ["confirmation-race"])).toEqual([
      { elementId: "confirmation-race", status: "guest-touched" },
    ]);
  });

  it("rejects an appState-only save when link edit access is revoked after the initial check", async () => {
    const drawing = await prisma.drawing.create({
      data: {
        name: "Revoked appState board",
        elements: "[]",
        appState: JSON.stringify({ theme: "light" }),
        files: "{}",
        userId: owner.id,
      },
    });
    const shareToken = buildShareLinkToken();
    const link = await prisma.drawingLinkShare.create({
      data: {
        drawingId: drawing.id,
        permission: "edit",
        tokenHash: hashShareLinkToken(shareToken),
        createdByUserId: owner.id,
      },
    });
    const resolveCapabilities = drawingCapabilities.getDrawingCapabilities;
    let targetChecks = 0;
    const capabilitySpy = vi
      .spyOn(drawingCapabilities, "getDrawingCapabilities")
      .mockImplementation(async (params) => {
        const decision = await resolveCapabilities(params);
        if (params.drawingId === drawing.id) {
          targetChecks += 1;
          if (targetChecks === 1) {
            await prisma.drawingLinkShare.update({
              where: { id: link.id },
              data: { revokedAt: new Date() },
            });
          }
        }
        return decision;
      });

    try {
      const guestAgent = request.agent(app);
      const csrf = await guestAgent.get("/csrf-token").set("User-Agent", "nil695-race-test");
      const response = await guestAgent
        .put(`/drawings/${drawing.id}`)
        .set("User-Agent", "nil695-race-test")
        .set("Authorization", `Bearer ${sign(stranger)}`)
        .set("x-share-token", shareToken)
        .set(csrf.body.header, csrf.body.token)
        .send({ version: drawing.version, appState: { theme: "dark" } });

      expect(response.status).toBe(404);
      expect(targetChecks).toBe(2);
      expect(
        JSON.parse(
          (await prisma.drawing.findUniqueOrThrow({ where: { id: drawing.id } })).appState,
        ),
      ).toEqual({ theme: "light" });
    } finally {
      capabilitySpy.mockRestore();
    }
  });

  it("tracks the real guest save, survives member moves, refuses guest clearance, and audits owner clearance", async () => {
    const scene = [
      { ...frame, id: "http-frame" },
      note({ id: "http-note", frameId: null }),
      note({ id: "refused-note", frameId: "http-frame" }),
    ];
    const drawing = await prisma.drawing.create({
      data: {
        name: "HTTP provenance board",
        elements: JSON.stringify(scene),
        appState: "{}",
        files: "{}",
        userId: owner.id,
      },
    });
    await registerAgentContext({
      prisma,
      drawingId: drawing.id,
      frameElementId: "http-frame",
    });
    const shareToken = buildShareLinkToken();
    await prisma.drawingLinkShare.create({
      data: {
        drawingId: drawing.id,
        permission: "edit",
        tokenHash: hashShareLinkToken(shareToken),
        createdByUserId: owner.id,
      },
    });

    const guestAgent = request.agent(app);
    const guestCsrf = await guestAgent.get("/csrf-token").set("User-Agent", "nil695-test");
    const guestHeaders = (verb: "put" | "post", path: string) =>
      guestAgent[verb](path)
        .set("User-Agent", "nil695-test")
        .set("Authorization", `Bearer ${sign(stranger)}`)
        .set("x-share-token", shareToken)
        .set(guestCsrf.body.header, guestCsrf.body.token);
    const ownerAgent = request.agent(app);
    const ownerCsrf = await ownerAgent.get("/csrf-token").set("User-Agent", "nil695-test");

    let live = await prisma.drawing.findUniqueOrThrow({ where: { id: drawing.id } });
    let elements = JSON.parse(live.elements) as Array<Record<string, unknown>>;
    elements = elements.map((element) =>
      element.id === "http-note" ? { ...element, text: "Guest instruction", version: 2 } : element,
    );
    const guestWrite = await guestHeaders("put", `/drawings/${drawing.id}`).send({
      version: live.version,
      elements,
      appState: {},
      files: {},
    });
    expect(guestWrite.status).toBe(200);

    for (let move = 1; move <= 3; move += 1) {
      live = await prisma.drawing.findUniqueOrThrow({ where: { id: drawing.id } });
      elements = (JSON.parse(live.elements) as Array<Record<string, unknown>>).map((element) =>
        element.id === "http-note"
          ? { ...element, x: 20 + move, frameId: "http-frame", version: 2 + move }
          : element,
      );
      const memberWrite = await ownerAgent
        .put(`/drawings/${drawing.id}`)
        .set("User-Agent", "nil695-test")
        .set("Authorization", `Bearer ${sign(owner)}`)
        .set(ownerCsrf.body.header, ownerCsrf.body.token)
        .send({ version: live.version, elements, appState: {}, files: {} });
      expect(memberWrite.status).toBe(200);
    }
    expect(await readElementGuestProvenance(prisma, drawing.id, ["http-note"])).toEqual([
      { elementId: "http-note", status: "guest-touched" },
    ]);

    const guestClear = await guestHeaders(
      "post",
      `/drawings/${drawing.id}/element-guest-provenance/confirm-clean`,
    ).send({ elementIds: ["http-note"] });
    expect(guestClear.status).toBe(404);
    expect(await readElementGuestProvenance(prisma, drawing.id, ["http-note"])).toEqual([
      { elementId: "http-note", status: "guest-touched" },
    ]);

    const previousAuditSetting = config.enableAuditLogging;
    config.enableAuditLogging = true;
    const ownerClear = await ownerAgent
      .post(`/drawings/${drawing.id}/element-guest-provenance/confirm-clean`)
      .set("User-Agent", "nil695-test")
      .set("Authorization", `Bearer ${sign(owner)}`)
      .set(ownerCsrf.body.header, ownerCsrf.body.token)
      .send({ elementIds: ["http-note", "refused-note"] });
    config.enableAuditLogging = previousAuditSetting;
    expect(ownerClear.status).toBe(200);
    expect(ownerClear.body.elements).toEqual([
      { elementId: "http-note", status: "confirmed-clean" },
      { elementId: "refused-note", status: "confirmed-clean" },
    ]);
    expect(
      await prisma.auditLog.findFirst({
        where: {
          userId: owner.id,
          action: "element_guest_provenance_confirmed_clean",
          resource: `drawing:${drawing.id}`,
        },
      }),
    ).toMatchObject({
      details: JSON.stringify({
        drawingId: drawing.id,
        elementIds: ["http-note", "refused-note"],
      }),
    });

    live = await prisma.drawing.findUniqueOrThrow({ where: { id: drawing.id } });
    const refusedElements = (JSON.parse(live.elements) as Array<Record<string, unknown>>).map(
      (element) =>
        element.id === "refused-note" ? { ...element, text: "Must not land", version: 2 } : element,
    );
    const refused = await guestHeaders("put", `/drawings/${drawing.id}`).send({
      version: live.version - 1,
      elements: refusedElements,
      appState: {},
      files: {},
    });
    expect(refused.status).toBe(409);
    expect(await readElementGuestProvenance(prisma, drawing.id, ["refused-note"])).toEqual([
      { elementId: "refused-note", status: "confirmed-clean" },
    ]);
  });

  it("records a link guest at the socket source before another client persists the scene", async () => {
    const untouchedMemberIds = ["member-note-1", "member-note-2"];
    const drawing = await prisma.drawing.create({
      data: {
        name: "Socket provenance board",
        elements: JSON.stringify([
          note({ id: "socket-note" }),
          ...untouchedMemberIds.map((id) => note({ id })),
        ]),
        appState: "{}",
        files: "{}",
        userId: owner.id,
      },
    });
    await recordSuccessfulElementMutation({
      prisma,
      drawingId: drawing.id,
      isGuest: false,
      changedElementIds: untouchedMemberIds,
      createdElementIds: untouchedMemberIds,
    });
    const shareToken = buildShareLinkToken();
    await prisma.drawingLinkShare.create({
      data: {
        drawingId: drawing.id,
        permission: "edit",
        tokenHash: hashShareLinkToken(shareToken),
        createdByUserId: owner.id,
      },
    });
    const io = new FakeIo();
    registerSocketHandlers({
      io: io as any,
      prisma,
      authModeService: { getAuthEnabled: async () => true } as any,
      jwtSecret: config.jwtSecret,
    });
    const socket = await io.connect("signed-in-link-guest", { token: sign(stranger) });
    await socket.trigger("join-room", {
      drawingId: drawing.id,
      shareToken,
      user: { name: "Must not become identity" },
    });
    await socket.trigger("element-update", {
      drawingId: drawing.id,
      elements: [{ ...note({ id: "socket-note" }), text: "Guest socket edit", version: 2 }],
      // The frontend sends the full board order whenever its signature
      // changes. It is synchronization metadata, not a list of mutations.
      elementOrder: ["member-note-1", "socket-note", "member-note-2"],
    });

    expect(
      await readElementGuestProvenance(prisma, drawing.id, ["socket-note", ...untouchedMemberIds]),
    ).toEqual([
      { elementId: "socket-note", status: "guest-touched" },
      { elementId: "member-note-1", status: "confirmed-clean" },
      { elementId: "member-note-2", status: "confirmed-clean" },
    ]);
    expect(io.emissions.some((entry) => entry.event === "element-update")).toBe(true);
  });
});
