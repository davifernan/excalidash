import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "../generated/client";
import { cleanupTestDb, createTestUser, getTestPrisma, setupTestDb } from "../__tests__/testUtils";
import {
  appendOrchestratorThreadMessage,
  getOrCreatePrivateOrchestratorThread,
  listOrchestratorThreadEvents,
  listVisibleOrchestratorThreads,
  movePrivateOrchestratorThread,
  registerDrawingOrchestratorThread,
} from "./orchestratorThreads";

const boardCard = (id: string, copiedThreadId: string, title: string) => ({
  id,
  type: "rectangle",
  isDeleted: false,
  customData: {
    excalidash: {
      schemaVersion: 2,
      orchestratorThread: { threadId: copiedThreadId, title },
    },
  },
});

describe("orchestrator threads: immutable local and drawing audiences", () => {
  let prisma: PrismaClient;
  let ownerId: string;
  let viewerId: string;
  let drawingId: string;

  beforeAll(() => {
    setupTestDb();
    prisma = getTestPrisma();
  });
  afterAll(async () => cleanupTestDb(prisma));

  beforeEach(async () => {
    await cleanupTestDb(prisma);
    ownerId = (await createTestUser(prisma, `thread-owner-${Date.now()}@example.com`)).id;
    viewerId = (await createTestUser(prisma, `thread-viewer-${Date.now()}@example.com`)).id;
    const drawing = await prisma.drawing.create({
      data: {
        name: "Board",
        appState: "{}",
        userId: ownerId,
        elements: JSON.stringify([
          boardCard("card-a", "copied-domain-id", "Shared A"),
          boardCard("card-b", "copied-domain-id", "Shared B"),
        ]),
      },
    });
    drawingId = drawing.id;
  });

  it("keeps one private history across devices and hides it from another board member", async () => {
    const firstDevice = await getOrCreatePrivateOrchestratorThread({
      prisma,
      drawingId,
      userId: ownerId,
      initialAnchor: { x: 10, y: 20 },
    });
    await appendOrchestratorThreadMessage({
      prisma,
      drawingId,
      threadId: firstDevice.id,
      userId: ownerId,
      displayName: "Owner",
      text: "private across devices",
    });

    const secondDevice = await getOrCreatePrivateOrchestratorThread({
      prisma,
      drawingId,
      userId: ownerId,
      initialAnchor: { x: 999, y: 999 },
    });
    expect(secondDevice.id).toBe(firstDevice.id);
    expect(secondDevice.anchor).toEqual({ kind: "private", x: 10, y: 20 });
    expect(
      await listOrchestratorThreadEvents({
        prisma,
        drawingId,
        threadId: secondDevice.id,
        userId: ownerId,
      }),
    ).toEqual([expect.objectContaining({ payload: { text: "private across devices" } })]);

    expect(
      (await listVisibleOrchestratorThreads({ prisma, drawingId, userId: viewerId })).map(
        (thread) => thread.id,
      ),
    ).not.toContain(firstDevice.id);
    await expect(
      listOrchestratorThreadEvents({
        prisma,
        drawingId,
        threadId: firstDevice.id,
        userId: viewerId,
      }),
    ).rejects.toMatchObject({ code: "THREAD_NOT_FOUND" });
  });

  it("treats copied customData identities as references, not a shared Board address", async () => {
    const first = await registerDrawingOrchestratorThread({
      prisma,
      drawingId,
      anchorElementId: "card-a",
    });
    const second = await registerDrawingOrchestratorThread({
      prisma,
      drawingId,
      anchorElementId: "card-b",
    });

    expect(first.id).not.toBe(second.id);
    expect(first.anchor).toEqual({ kind: "drawing", elementId: "card-a" });
    expect(second.anchor).toEqual({ kind: "drawing", elementId: "card-b" });
  });

  it("cannot move a drawing-audience thread through the private anchor seam", async () => {
    const shared = await registerDrawingOrchestratorThread({
      prisma,
      drawingId,
      anchorElementId: "card-a",
    });
    await expect(
      movePrivateOrchestratorThread({
        prisma,
        drawingId,
        threadId: shared.id,
        userId: ownerId,
        anchor: { x: 5, y: 5 },
      }),
    ).rejects.toMatchObject({ code: "THREAD_NOT_FOUND" });
    expect((await prisma.agentThread.findUnique({ where: { id: shared.id } }))?.audienceKind).toBe(
      "drawing",
    );
  });
});
