import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcrypt";
import jwt, { type SignOptions } from "jsonwebtoken";
import type { StringValue } from "ms";
import { PrismaClient } from "../generated/client";
import { config } from "../config";
import { registerAgentContext } from "../agent/boardContexts";
import { executeAgentBoardTool } from "../agent/boardMount";
import { getTestPrisma, setupTestDb } from "./testUtils";

describe("immutable Agent Board Mount (NIL-671)", () => {
  const userAgent = "vitest-agent-board-mount";
  let prisma: PrismaClient;
  let app: any;
  let drawingId: string;
  let contextAId: string;
  let contextBId: string;
  let agentToken: string;
  let ownerToken: string;
  let ownerAgent: any;
  let ownerCsrfHeaderName: string;
  let ownerCsrfToken: string;

  const frame = (id: string, x: number) => ({
    id,
    type: "frame",
    name: id === "frame-a" ? "Public planning" : "Private finance",
    x,
    y: 0,
    width: 400,
    height: 400,
    angle: 0,
    isDeleted: false,
  });
  const fixtureElements = () => [
    frame("frame-a", 0),
    {
      id: "answer-a",
      type: "text",
      text: "Launch answer is ORANGE",
      x: 20,
      y: 30,
      width: 180,
      height: 30,
      frameId: "frame-a",
      isDeleted: false,
      boundElements: [{ id: "edge-cross", type: "arrow" }],
    },
    {
      id: "edge-cross",
      type: "arrow",
      x: 100,
      y: 100,
      width: 500,
      height: 0,
      frameId: "frame-a",
      isDeleted: false,
      startBinding: { elementId: "answer-a" },
      endBinding: { elementId: "secret-b" },
    },
    {
      id: "asset-a-widget",
      type: "embeddable",
      x: 20,
      y: 160,
      width: 200,
      height: 100,
      frameId: "frame-a",
      link: "excalidash://asset-widget",
      isDeleted: false,
      customData: {
        excalidash: {
          schemaVersion: 2,
          widget: { kind: "text", assetId: "asset-a" },
        },
      },
    },
    frame("frame-b", 500),
    {
      id: "secret-b",
      type: "text",
      text: "FOREIGN-CONTEXT-PAYROLL-SECRET",
      x: 520,
      y: 30,
      width: 260,
      height: 30,
      frameId: "frame-b",
      isDeleted: false,
      boundElements: [{ id: "edge-cross", type: "arrow" }],
    },
    {
      id: "asset-b-widget",
      type: "embeddable",
      x: 520,
      y: 100,
      width: 200,
      height: 100,
      frameId: "frame-b",
      link: "excalidash://asset-widget",
      isDeleted: false,
      customData: {
        excalidash: {
          schemaVersion: 2,
          widget: { kind: "text", assetId: "asset-b" },
        },
      },
    },
    {
      id: "outside",
      type: "text",
      text: "OUTSIDE-CONTEXT-MUST-NOT-APPEAR",
      x: 1000,
      y: 1000,
      width: 200,
      height: 30,
      frameId: null,
      isDeleted: false,
    },
  ];

  const tool = async (
    mount: any,
    name: string,
    args: Record<string, unknown> = {},
    token = mount.capabilityToken,
  ) =>
    request(app)
      .post(`/drawings/${drawingId}/agent/mounts/${mount.runId}/tools/${name}`)
      .set("Authorization", `Bearer ${agentToken}`)
      .set("x-agent-mount-token", token)
      .send(args);

  beforeAll(async () => {
    setupTestDb();
    prisma = getTestPrisma();
    ({ app } = await import("../index"));
    await prisma.systemConfig.upsert({
      where: { id: "default" },
      update: { authEnabled: true, registrationEnabled: false },
      create: { id: "default", authEnabled: true, registrationEnabled: false },
    });
    const owner = await prisma.user.create({
      data: {
        email: "board-mount-owner@test.local",
        passwordHash: await bcrypt.hash("password123", 10),
        name: "Owner",
        role: "USER",
        isActive: true,
      },
      select: { id: true, email: true },
    });
    const signOptions: SignOptions = { expiresIn: config.jwtAccessExpiresIn as StringValue };
    ownerToken = jwt.sign(
      { userId: owner.id, email: owner.email, type: "access" },
      config.jwtSecret,
      signOptions,
    );
    const drawing = await prisma.drawing.create({
      data: {
        name: "Gate 1 board",
        elements: JSON.stringify(fixtureElements()),
        appState: "{}",
        files: "{}",
        userId: owner.id,
      },
    });
    drawingId = drawing.id;
    const contextA = await registerAgentContext({
      prisma,
      drawingId,
      frameElementId: "frame-a",
      pinned: true,
    });
    const contextB = await registerAgentContext({
      prisma,
      drawingId,
      frameElementId: "frame-b",
    });
    contextAId = contextA.id;
    contextBId = contextB.id;

    for (const side of ["a", "b"] as const) {
      const blob = await prisma.storedBlob.create({
        data: {
          id: `blob-${side}`,
          sha256: side.repeat(64),
          sizeBytes: 16,
          storedBytes: 16,
          storageKey: `does-not-need-to-exist-for-${side}-metadata`,
          state: "READY",
        },
      });
      await prisma.asset.create({
        data: {
          id: `asset-${side}`,
          ownerUserId: owner.id,
          blobId: blob.id,
          kind: "TEXT",
          originalName: side === "a" ? "launch-notes.txt" : "foreign-payroll.txt",
          mimeType: "text/plain",
        },
      });
      await prisma.drawingAsset.create({
        data: { drawingId, assetId: `asset-${side}`, state: "ACTIVE" },
      });
    }

    ownerAgent = request.agent(app);
    const csrf = await ownerAgent.get("/csrf-token").set("User-Agent", userAgent);
    ownerCsrfHeaderName = csrf.body.header;
    ownerCsrfToken = csrf.body.token;
    const minted = await ownerAgent
      .post("/auth/api-keys")
      .set("User-Agent", userAgent)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set(ownerCsrfHeaderName, ownerCsrfToken)
      .send({ name: "Gate 1 Agent", drawingId, scopes: ["drawing:read"] });
    expect(minted.status).toBe(201);
    agentToken = minted.body.token;
  }, 120000);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const createMount = async (overrides: Record<string, unknown> = {}) => {
    const response = await ownerAgent
      .post(`/drawings/${drawingId}/agent/mounts`)
      .set("User-Agent", userAgent)
      .set("Authorization", `Bearer ${ownerToken}`)
      .set(ownerCsrfHeaderName, ownerCsrfToken)
      .send({ allowedContextIds: [contextAId], ...overrides });
    expect(response.status).toBe(201);
    return response.body;
  };

  it("pins every read in a run to one revision even after the mutable board changes", async () => {
    const mount = await createMount({ runId: "gate-1-pinning" });
    const before = await tool(mount, "readFrame", { frameElementId: "frame-a" });
    expect(before.status).toBe(200);
    expect(
      before.body.result.elements.some((element: any) => element.text?.includes("ORANGE")),
    ).toBe(true);

    const drawing = await prisma.drawing.findUniqueOrThrow({ where: { id: drawingId } });
    const changed = fixtureElements().map((element) =>
      element.id === "answer-a" ? { ...element, text: "Launch answer changed to BLUE" } : element,
    );
    await prisma.drawing.update({
      where: { id: drawingId },
      data: { elements: JSON.stringify(changed), version: { increment: 1 } },
    });
    await prisma.asset.update({
      where: { id: "asset-a" },
      data: { originalName: "renamed-after-mount.txt" },
    });

    const after = await tool(mount, "readFrame", { frameElementId: "frame-a" });
    expect(after.status).toBe(200);
    expect(after.body.revisionId).toBe(mount.revisionId);
    expect(after.body.result).toEqual(before.body.result);
    expect(after.body.resultHash).toBe(before.body.resultHash);
    const pinnedAsset = await tool(mount, "readAsset", { assetId: "asset-a" });
    expect(pinnedAsset.status).toBe(200);
    expect(pinnedAsset.body.result.name).toBe("launch-notes.txt");

    const status = await tool(mount, "revisionStatus");
    expect(status.status).toBe(200);
    expect(status.body.revisionId).toBe(mount.revisionId);
    expect(status.body.result).toMatchObject({ changed: true });
    expect(status.body.result.latestRevisionId).not.toBe(mount.revisionId);
  });

  it("enforces allowedContextIds transitively across ids, edges, search, render, and assets", async () => {
    const mount = await createMount({ runId: "negative-context-boundary" });
    const contexts = await tool(mount, "listContexts");
    expect(contexts.body.result.map((context: any) => context.contextId)).toEqual([contextAId]);
    expect(JSON.stringify(contexts.body)).not.toContain(contextBId);
    expect(JSON.stringify(contexts.body)).not.toContain("Private finance");

    const edge = await tool(mount, "followEdge", { edgeElementId: "edge-cross" });
    expect(edge.status).toBe(200);
    expect(edge.body.result.end).toBeNull();
    expect(edge.body.result.semantics).toEqual({ kind: "unspecified" });
    expect(JSON.stringify(edge.body)).not.toContain("secret-b");

    const foreignElement = await tool(mount, "readElements", { ids: ["secret-b"] });
    expect(foreignElement.status).toBe(400);
    expect(JSON.stringify(foreignElement.body)).not.toContain("FOREIGN-CONTEXT-PAYROLL-SECRET");
    const search = await tool(mount, "search", { query: "PAYROLL" });
    expect(search.body.result).toEqual([]);

    const rendered = await tool(mount, "render", { contextId: contextAId });
    expect(rendered.status).toBe(200);
    expect(rendered.body.result.rendererVersion).toBe("agent-svg-v1");
    expect(rendered.body.result.svg).not.toContain("PAYROLL");
    expect(rendered.body.result.svg).not.toContain("OUTSIDE-CONTEXT");

    const foreignAsset = await tool(mount, "readAsset", { assetId: "asset-b" });
    expect(foreignAsset.status).toBe(400);
    expect(JSON.stringify(foreignAsset.body)).not.toContain("foreign-payroll.txt");
  });

  it("requires the run-bound capability token and audits successful result hashes", async () => {
    const mount = await createMount({ runId: "capability-and-audit" });
    const refused = await tool(mount, "overview", {}, "wrong-token");
    expect(refused.status).toBe(404);
    const accepted = await tool(mount, "overview");
    expect(accepted.status).toBe(200);
    const audit = await prisma.agentToolAudit.findFirstOrThrow({
      where: { runId: mount.runId, tool: "overview" },
    });
    expect(audit.revisionId).toBe(mount.revisionId);
    expect(audit.resultHash).toBe(accepted.body.resultHash);
    expect(audit.argsHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("emits no target before authorization and closes an authorized failed read on the pinned revision", async () => {
    const mount = await createMount({
      runId: "focus-after-authorization",
      displayName: "Research",
      visibility: "drawing",
    });
    const events: any[] = [];

    await expect(
      executeAgentBoardTool({
        prisma,
        drawingId,
        runId: mount.runId,
        capabilityToken: mount.capabilityToken,
        tool: "readElements",
        args: { ids: ["secret-b"] },
        onFocus: (event) => events.push(event),
      }),
    ).rejects.toMatchObject({ code: "ELEMENT_NOT_READABLE" });
    expect(events).toEqual([]);

    await expect(
      executeAgentBoardTool({
        prisma,
        drawingId,
        runId: mount.runId,
        capabilityToken: mount.capabilityToken,
        tool: "readFrame",
        args: { frameElementId: "answer-a" },
        onFocus: (event) => events.push(event),
      }),
    ).rejects.toMatchObject({ code: "FRAME_NOT_READABLE" });
    expect(events.map((event) => event.phase)).toEqual(["started", "finished"]);
    expect(events.map((event) => event.revisionId)).toEqual([mount.revisionId, mount.revisionId]);
    expect(events.every((event) => event.targetIds.join(",") === "answer-a")).toBe(true);

    events.length = 0;
    await executeAgentBoardTool({
      prisma,
      drawingId,
      runId: mount.runId,
      capabilityToken: mount.capabilityToken,
      tool: "readFrame",
      args: { frameElementId: "frame-a" },
      onFocus: (event) => events.push(event),
    });
    expect(events.map((event) => [event.phase, event.targetIds])).toEqual([
      ["started", ["frame-a"]],
      ["finished", ["frame-a"]],
    ]);
    expect(events.every((event) => event.revisionId === mount.revisionId)).toBe(true);

    events.length = 0;
    await executeAgentBoardTool({
      prisma,
      drawingId,
      runId: mount.runId,
      capabilityToken: mount.capabilityToken,
      tool: "search",
      args: { query: "Launch answer" },
      onFocus: (event) => events.push(event),
    });
    expect(events.map((event) => [event.phase, event.targetIds])).toEqual([
      ["started", ["answer-a"]],
      ["finished", ["answer-a"]],
    ]);
    expect(events.every((event) => event.revisionId === mount.revisionId)).toBe(true);
  });

  it("does not let a run lacking render capability call render", async () => {
    const mount = await createMount({
      runId: "explore-only",
      capabilities: ["board:explore"],
    });
    const overview = await tool(mount, "overview");
    expect(overview.status).toBe(200);
    const render = await tool(mount, "render");
    expect(render.status).toBe(403);
    expect(render.body.code).toBe("CAPABILITY_MISSING");
  });
});
