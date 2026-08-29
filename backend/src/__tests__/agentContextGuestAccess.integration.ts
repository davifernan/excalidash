import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../generated/client";
import request from "supertest";
import jwt, { type SignOptions } from "jsonwebtoken";
import type { StringValue } from "ms";
import { registerAgentContext } from "../agent/boardContexts";
import { executeAgentBoardTool } from "../agent/boardMount";
import {
  confirmElementGuestProvenance,
  recordSuccessfulElementMutation,
} from "../agent/elementGuestProvenance";
import { getTestPrisma, setupTestDb } from "./testUtils";
import { buildShareLinkToken, hashShareLinkToken } from "../authz/sharing";
import { config } from "../config";
import { logger } from "../logger";

/**
 * NIL-677: agent_context:write (Gate 1, preventive) and agent_context:contribute
 * (Gate 2, the actual guarantee) for guests. Two questions, two mechanisms,
 * exercised end to end through the real HTTP/tool surfaces -- not through
 * the boardContexts.ts/elementGuestProvenance.ts helpers directly, since the
 * point of both gates is that they run at the real write and read paths.
 */
describe("agent context guest access (NIL-677)", () => {
  let prisma: PrismaClient;
  let app: any;
  let owner: { id: string; email: string };
  let guestAccount: { id: string; email: string };
  let member: { id: string; email: string };

  const sign = (user: { id: string; email: string }) => {
    const options: SignOptions = { expiresIn: config.jwtAccessExpiresIn as StringValue };
    return jwt.sign(
      { userId: user.id, email: user.email, type: "access" },
      config.jwtSecret,
      options,
    );
  };

  const frame = {
    id: "agent-frame-1",
    type: "frame",
    name: "Agent Context",
    x: 0,
    y: 0,
    width: 400,
    height: 400,
    angle: 0,
    isDeleted: false,
  };

  const outsideNote = {
    id: "outside-note",
    type: "text",
    text: "outside the frame",
    x: 1000,
    y: 1000,
    width: 120,
    height: 40,
    frameId: null,
    isDeleted: false,
  };

  const insideNote = {
    id: "inside-note",
    type: "text",
    text: "already inside the frame",
    x: 20,
    y: 20,
    width: 120,
    height: 40,
    frameId: frame.id,
    isDeleted: false,
  };

  let drawingId: string;

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
      data: { email: "nil677-owner@test.local", passwordHash: "not-used", name: "Owner" },
      select: { id: true, email: true },
    });
    guestAccount = await prisma.user.create({
      data: { email: "nil677-guest@test.local", passwordHash: "not-used", name: "Link guest" },
      select: { id: true, email: true },
    });
    member = await prisma.user.create({
      data: { email: "nil677-member@test.local", passwordHash: "not-used", name: "Member" },
      select: { id: true, email: true },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  afterEach(async () => {
    await prisma.systemConfig.update({
      where: { id: "default" },
      data: { guestAgentContextContributeEnabled: false },
    });
  });

  const buildDrawing = async () => {
    const drawing = await prisma.drawing.create({
      data: {
        name: "NIL-677 board",
        elements: JSON.stringify([frame, insideNote, outsideNote]),
        appState: "{}",
        files: "{}",
        userId: owner.id,
      },
    });
    await prisma.drawingPermission.create({
      data: {
        drawingId: drawing.id,
        granteeUserId: member.id,
        permission: "edit",
        createdByUserId: owner.id,
      },
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
    const registration = await registerAgentContext({
      prisma,
      drawingId: drawing.id,
      frameElementId: frame.id,
    });
    // Registration conservatively marks pre-existing content guest-touched
    // pending review. Confirm it here so each test starts from a known,
    // deliberately chosen provenance state instead of the registration
    // default -- individual tests below set up their own guest/member
    // touches on top of this clean baseline.
    await confirmElementGuestProvenance(
      prisma,
      drawing.id,
      registration.provenanceReview.elementIdsRequiringConfirmation,
    );
    return { drawingId: drawing.id, shareToken };
  };

  const putScene = (params: {
    id: string;
    shareToken?: string;
    asUser: { id: string; email: string };
    version: number;
    elements: unknown[];
  }) => {
    const guestClient = request.agent(app);
    return (async () => {
      const csrf = await guestClient.get("/csrf-token").set("User-Agent", "nil677-test");
      let req = guestClient
        .put(`/drawings/${params.id}`)
        .set("User-Agent", "nil677-test")
        .set("Authorization", `Bearer ${sign(params.asUser)}`)
        .set(csrf.body.header, csrf.body.token);
      if (params.shareToken) req = req.set("x-share-token", params.shareToken);
      return req.send({ version: params.version, elements: params.elements });
    })();
  };

  describe("Gate 1: agent_context:write", () => {
    it("refuses a guest write that moves an element into a registered Agent Context frame", async () => {
      const { drawingId, shareToken } = await buildDrawing();
      const movedIn = { ...outsideNote, frameId: frame.id, x: 30, y: 30 };
      const response = await putScene({
        id: drawingId,
        shareToken,
        asUser: guestAccount,
        version: 1,
        elements: [frame, insideNote, movedIn],
      });

      expect(response.status).toBe(403);
      expect(response.body.code).toBe("AGENT_CONTEXT_GUEST_WRITE_DENIED");

      const persisted = JSON.parse(
        (await prisma.drawing.findUniqueOrThrow({ where: { id: drawingId } })).elements,
      );
      expect(persisted.find((element: any) => element.id === "outside-note").frameId).toBeNull();
    });

    it("still lets the same guest write an element that stays outside the frame", async () => {
      const { drawingId, shareToken } = await buildDrawing();
      const edited = { ...outsideNote, text: "guest edited this, still outside" };
      const response = await putScene({
        id: drawingId,
        shareToken,
        asUser: guestAccount,
        version: 1,
        elements: [frame, insideNote, edited],
      });

      expect(response.status).toBe(200);
      const persisted = JSON.parse(
        (await prisma.drawing.findUniqueOrThrow({ where: { id: drawingId } })).elements,
      );
      expect(persisted.find((element: any) => element.id === "outside-note").text).toBe(
        "guest edited this, still outside",
      );
    });

    it("a member may still move a legacy element into the frame -- Gate 1 only restricts guests", async () => {
      const { drawingId, shareToken: _unused } = await buildDrawing();
      const movedIn = { ...outsideNote, frameId: frame.id, x: 30, y: 30 };
      const memberClient = request.agent(app);
      const csrf = await memberClient.get("/csrf-token").set("User-Agent", "nil677-member-test");
      const response = await memberClient
        .put(`/drawings/${drawingId}`)
        .set("User-Agent", "nil677-member-test")
        .set("Authorization", `Bearer ${sign(member)}`)
        .set(csrf.body.header, csrf.body.token)
        .send({ version: 1, elements: [frame, insideNote, movedIn] });

      expect(response.status).toBe(200);
    });
  });

  const mountAndReadFrame = async (drawingId: string) => {
    const ownerClient = request.agent(app);
    const ownerCsrf = await ownerClient.get("/csrf-token").set("User-Agent", "nil677-mount");
    const created = await ownerClient
      .post(`/drawings/${drawingId}/agent/mounts`)
      .set("User-Agent", "nil677-mount")
      .set("Authorization", `Bearer ${sign(owner)}`)
      .set(ownerCsrf.body.header, ownerCsrf.body.token)
      .send({ displayName: "Nil-677 test agent", audience: { kind: "public" } });
    expect(created.status).toBe(201);
    const mount = created.body;
    return ownerClient
      .post(`/drawings/${drawingId}/agent/mounts/${mount.runId}/tools/readFrame`)
      .set("User-Agent", "nil677-mount")
      .set("Authorization", `Bearer ${sign(owner)}`)
      .set("x-agent-mount-token", mount.capabilityToken)
      .set(ownerCsrf.body.header, ownerCsrf.body.token)
      .send({ frameElementId: frame.id });
  };

  describe("Gate 2: agent_context:contribute", () => {
    it("excludes a guest-touched element from the compiled context even though it physically sits in the frame", async () => {
      const { drawingId } = await buildDrawing();
      // The member-drag path from the Gate 1 describe block above: Gate 1
      // never applies to this write, so the element ends up in the frame's
      // geometry with guest-touched provenance and no Gate-1 violation ever
      // recorded -- exactly the "not proof of a Gate 1 leak" case Gate 2's
      // own log message documents.
      await recordSuccessfulElementMutation({
        prisma,
        drawingId,
        isGuest: true,
        changedElementIds: ["outside-note"],
        createdElementIds: [],
      });
      const movedIn = { ...outsideNote, frameId: frame.id, x: 30, y: 30 };
      await prisma.drawing.update({
        where: { id: drawingId },
        data: { elements: JSON.stringify([frame, insideNote, movedIn]), version: { increment: 1 } },
      });

      const logSpy = vi.spyOn(logger, "warn");
      const response = await mountAndReadFrame(drawingId);

      expect(response.status).toBe(200);
      const elementIds = response.body.result.elements.map((element: any) => element.id);
      expect(elementIds).toContain("inside-note");
      expect(elementIds).not.toContain("outside-note");
      expect(logSpy).toHaveBeenCalledWith(
        "NIL-677 Gate 2 excluded a Context-readable element from Agent Context",
        expect.objectContaining({ elementId: "outside-note", provenanceStatus: "guest-touched" }),
      );
      logSpy.mockRestore();
    });

    it("includes the same guest-touched element once the board (and instance) allow guest contribution", async () => {
      const { drawingId } = await buildDrawing();
      await recordSuccessfulElementMutation({
        prisma,
        drawingId,
        isGuest: true,
        changedElementIds: ["outside-note"],
        createdElementIds: [],
      });
      const movedIn = { ...outsideNote, frameId: frame.id, x: 30, y: 30 };
      await prisma.drawing.update({
        where: { id: drawingId },
        data: { elements: JSON.stringify([frame, insideNote, movedIn]), version: { increment: 1 } },
      });
      await prisma.systemConfig.update({
        where: { id: "default" },
        data: { guestAgentContextContributeEnabled: true },
      });
      await prisma.drawing.update({
        where: { id: drawingId },
        data: { guestAgentContextContributeEnabled: true },
      });

      const response = await mountAndReadFrame(drawingId);

      expect(response.status).toBe(200);
      const elementIds = response.body.result.elements.map((element: any) => element.id);
      expect(elementIds).toContain("outside-note");
    });

    it("keeps guest contribution closed if only the board opts in but the instance ceiling stays closed", async () => {
      const { drawingId } = await buildDrawing();
      await recordSuccessfulElementMutation({
        prisma,
        drawingId,
        isGuest: true,
        changedElementIds: ["outside-note"],
        createdElementIds: [],
      });
      const movedIn = { ...outsideNote, frameId: frame.id, x: 30, y: 30 };
      await prisma.drawing.update({
        where: { id: drawingId },
        data: { elements: JSON.stringify([frame, insideNote, movedIn]), version: { increment: 1 } },
      });
      // Instance ceiling deliberately left false (afterEach's baseline).
      await prisma.drawing.update({
        where: { id: drawingId },
        data: { guestAgentContextContributeEnabled: true },
      });

      const response = await mountAndReadFrame(drawingId);

      expect(response.status).toBe(200);
      const elementIds = response.body.result.elements.map((element: any) => element.id);
      expect(elementIds).not.toContain("outside-note");
    });

    it("always keeps the frame's own boundary element readable regardless of its provenance", async () => {
      const { drawingId } = await buildDrawing();
      // Simulate a pre-existing frame registered without ever confirming its
      // own provenance -- registerAgentContext's conservative backfill marks
      // it guest-touched by default (see boardContexts.ts).
      await recordSuccessfulElementMutation({
        prisma,
        drawingId,
        isGuest: true,
        changedElementIds: [frame.id],
        createdElementIds: [],
      });

      const response = await mountAndReadFrame(drawingId);

      expect(response.status).toBe(200);
      expect(response.body.result.frame.id).toBe(frame.id);
    });
  });
});
