import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../generated/client";
import { cleanupTestDb, createTestUser, getTestPrisma, setupTestDb } from "../__tests__/testUtils";
import {
  ContextThreadError,
  ContextThreadCorruptionError,
  appendContextThreadEvent,
  listContextThreadEvents,
  listResolvedContextThreadEvents,
  resolveContextThreadForRun,
  resolveThreadState,
} from "./contextThread";

describe("context thread: append-only event log", () => {
  let prisma: PrismaClient;
  let userId: string;
  let drawingId: string;
  let contextId: string;

  beforeAll(async () => {
    setupTestDb();
    prisma = getTestPrisma();
  });

  afterAll(async () => {
    if (prisma) await cleanupTestDb(prisma);
  });

  beforeEach(async () => {
    await cleanupTestDb(prisma);
    const user = await createTestUser(prisma, `contextthread-${Date.now()}@example.com`);
    userId = user.id;
    const drawing = await prisma.drawing.create({
      data: { name: "Board", elements: "[]", appState: "{}", userId },
    });
    drawingId = drawing.id;
    const context = await prisma.agentContext.create({
      data: { drawingId, frameElementId: "frame-1" },
    });
    contextId = context.id;
    await prisma.agentThread.create({
      data: {
        id: contextId,
        drawingId,
        threadKind: "context",
        audienceKind: "drawing",
        contextId,
        title: "Context thread",
      },
    });
  });

  const append = (
    kind: string,
    payload: Record<string, unknown>,
    actor: { kind: "user" | "agent" | "system"; displayName: string } = {
      kind: "agent",
      displayName: "Research Agent",
    },
  ) =>
    appendContextThreadEvent({
      prisma,
      drawingId,
      contextId,
      actor,
      kind: kind as any,
      payload,
    });

  const readStoredRow = (overrides: Record<string, unknown>) =>
    listContextThreadEvents({
      prisma: {
        agentContext: { findFirst: async () => ({ thread: { id: contextId } }) },
        agentThread: { findFirst: async () => ({ id: contextId }) },
        agentThreadEvent: {
          findMany: async () => [
            {
              id: "stored-event-1",
              threadId: contextId,
              sequence: 1,
              actorKind: "agent",
              actorId: null,
              actorDisplayName: "Research Agent",
              eventKind: "message",
              payload: '{"text":"hello"}',
              createdAt: new Date("2026-08-29T18:00:00.000Z"),
              ...overrides,
            },
          ],
        },
      },
      drawingId,
      contextId,
    });

  it("assigns a strictly increasing sequence, shared with concurrent appends", async () => {
    const [a, b, c, d] = await Promise.all([
      append("message", { text: "one" }),
      append("message", { text: "two" }),
      append("message", { text: "three" }),
      append("message", { text: "four" }),
    ]);
    const sequences = [a, b, c, d].map((event) => event.sequence).sort((x, y) => x - y);
    expect(sequences).toEqual([1, 2, 3, 4]);

    const listed = await listContextThreadEvents({ prisma, drawingId, contextId });
    expect(listed.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
  });

  it("rejects an edit or retract that references a correction instead of a root event", async () => {
    const original = await append("message", { text: "hello" });
    const edit = await append("edit", { supersedes: original.id, text: "hello, corrected" });

    await expect(append("edit", { supersedes: edit.id, text: "double edit" })).rejects.toThrow(
      ContextThreadError,
    );
    await expect(append("retract", { retracts: edit.id })).rejects.toThrow(ContextThreadError);
  });

  it("rejects an edit/retract referencing an id that does not exist in this Context", async () => {
    await expect(append("edit", { supersedes: "nope", text: "x" })).rejects.toThrow(
      ContextThreadError,
    );
    await expect(append("retract", { retracts: "nope" })).rejects.toThrow(ContextThreadError);
  });

  describe("supersession resolution", () => {
    it("a retracted event never appears in the run-context reader", async () => {
      const original = await append("message", { text: "delete me" });
      await append("retract", { retracts: original.id });

      const forRun = await resolveContextThreadForRun({ prisma, drawingId, contextId });
      expect(forRun.map((event) => event.id)).not.toContain(original.id);
      expect(forRun).toHaveLength(0);
    });

    it("retraction is terminal: a later edit cannot revive a retracted event", async () => {
      const original = await append("message", { text: "delete me" });
      await append("retract", { retracts: original.id });
      // Sequence-later than the retract, same root -- must not un-retract it.
      await append("edit", { supersedes: original.id, text: "actually keep this" });

      const forRun = await resolveContextThreadForRun({ prisma, drawingId, contextId });
      expect(forRun).toHaveLength(0);

      const resolved = await listResolvedContextThreadEvents({ prisma, drawingId, contextId });
      expect(resolved).toHaveLength(1);
      expect(resolved[0]!.status).toBe("retracted");
    });

    it("a chain of corrections resolves to the same final content in both readers", async () => {
      const original = await append("message", { text: "v1" });
      await append("edit", { supersedes: original.id, text: "v2" });
      await append("edit", { supersedes: original.id, text: "v3" });
      const lastEdit = await append("edit", { supersedes: original.id, text: "v4" });

      const forRun = await resolveContextThreadForRun({ prisma, drawingId, contextId });
      expect(forRun).toHaveLength(1);
      expect(forRun[0]!.payload.text).toBe("v4");
      expect(forRun[0]!.id).toBe(lastEdit.id);

      const resolved = await listResolvedContextThreadEvents({ prisma, drawingId, contextId });
      expect(resolved).toHaveLength(1);
      expect(resolved[0]!.status).toBe("edited");
      expect(resolved[0]!.currentEdit?.payload.text).toBe("v4");
      expect(resolved[0]!.currentEdit?.id).toBe(lastEdit.id);
      expect(resolved[0]!.edits.map((edit) => edit.payload.text)).toEqual(["v2", "v3", "v4"]);

      // The property under test: both readers name the exact same winning
      // event for the same chain, not just equal-looking text.
      expect(resolved[0]!.currentEdit?.id).toBe(forRun[0]!.id);
    });

    it("an untouched root event stays active in both readers", async () => {
      const original = await append("message", { text: "untouched" });

      const forRun = await resolveContextThreadForRun({ prisma, drawingId, contextId });
      expect(forRun.map((event) => event.id)).toEqual([original.id]);

      const resolved = await listResolvedContextThreadEvents({ prisma, drawingId, contextId });
      expect(resolved[0]!.status).toBe("active");
      expect(resolved[0]!.currentEdit).toBeNull();
    });

    it("resolveThreadState is a pure function of its input (no hidden dependency on fetch order)", () => {
      const base = {
        threadId: contextId,
        contextId,
        actor: { kind: "agent" as const, id: null, displayName: "Agent" },
        createdAt: new Date().toISOString(),
      };
      const events = [
        {
          ...base,
          id: "edit-2",
          sequence: 5,
          kind: "edit" as const,
          payload: { supersedes: "root-1", text: "c" },
        },
        {
          ...base,
          id: "root-2",
          sequence: 3,
          kind: "status" as const,
          payload: { status: "working" },
        },
        {
          ...base,
          id: "edit-1",
          sequence: 2,
          kind: "edit" as const,
          payload: { supersedes: "root-1", text: "b" },
        },
        { ...base, id: "root-1", sequence: 1, kind: "message" as const, payload: { text: "a" } },
      ];
      const resolvedAsIs = resolveThreadState(events);
      const resolvedShuffled = resolveThreadState([...events].reverse());
      expect(resolvedAsIs).toEqual(resolvedShuffled);
      expect(resolvedAsIs.map((entry) => entry.original.id)).toEqual(["root-1", "root-2"]);
      expect(resolvedAsIs[0]!.edits.map((entry) => entry.id)).toEqual(["edit-1", "edit-2"]);
      expect(resolvedAsIs[0]!.currentEdit?.payload.text).toBe("c");
    });
  });

  it("fails loudly when a persisted row is corrupt instead of inventing a placeholder event", async () => {
    await prisma.agentThreadEvent.create({
      data: {
        threadId: contextId,
        sequence: 1,
        actorKind: "agent",
        actorDisplayName: "Research Agent",
        eventKind: "message",
        payload: "{not-json",
      },
    });

    await expect(listContextThreadEvents({ prisma, drawingId, contextId })).rejects.toThrow(
      ContextThreadCorruptionError,
    );
  });

  it("identifies an unreadable persisted payload without logging any payload content", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await prisma.agentThreadEvent.create({
        data: {
          threadId: contextId,
          sequence: 1,
          actorKind: "agent",
          actorDisplayName: "Research Agent",
          eventKind: "message",
          payload: "LEAKME42-not-json",
        },
      });

      await expect(listContextThreadEvents({ prisma, drawingId, contextId })).rejects.toThrow(
        ContextThreadCorruptionError,
      );

      const logged = stderr.mock.calls.map(([chunk]) => String(chunk)).join("\n");
      expect(logged).toContain("Stored Agent thread event is corrupt");
      expect(logged).toContain(contextId);
      expect(logged).not.toContain("LEAKME42");
    } finally {
      stderr.mockRestore();
    }
  });

  it("reports invalid kind fields without echoing their stored values", async () => {
    for (const [field, marker] of [
      ["actorKind", "LEAKME-ACTOR-KIND"],
      ["eventKind", "LEAKME-EVENT-KIND"],
    ] as const) {
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      let caught: unknown;
      let logged = "";
      try {
        await readStoredRow({ [field]: marker });
      } catch (error) {
        caught = error;
      } finally {
        logged = stderr.mock.calls.map(([chunk]) => String(chunk)).join("\n");
        stderr.mockRestore();
      }

      expect(caught).toBeInstanceOf(ContextThreadCorruptionError);
      const observable = `${logged}\n${String(caught)}`;
      expect(observable).toContain("Stored Agent thread event is corrupt");
      expect(observable).not.toContain(marker);
    }
  });

  it("rejects an invalid stored actorId type instead of silently treating it as null", async () => {
    await expect(readStoredRow({ actorId: { forged: "system" } })).rejects.toThrow(
      ContextThreadCorruptionError,
    );
  });
});
