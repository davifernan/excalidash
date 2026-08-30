/**
 * NIL-701 stage setup for Gate 2 (visible Agent Presence). Builds none of the
 * gate's judgment -- it only makes `gate2PresenceFixture`
 * (e2e/tests/fixtures/agentContextGateFixtures.ts) exist as real drawing,
 * Agent Context, and mount rows on whatever backend DATABASE_URL this script
 * is pointed at. Run it against the SAME database the running server process
 * Davi will open in his browser also points at -- it does not start a server
 * itself.
 *
 * Usage (from backend/):
 *   GATE_OWNER_EMAIL=owner@example.com \
 *   npm run gate-run:setup-gate2
 *
 * Why this cannot be a Playwright/e2e script: registering an Agent Context
 * (the frame -> context binding every gate depends on) has no HTTP route
 * today -- `registerAgentContext` is only ever called from backend code and
 * from `backend/src/__tests__/*.integration.ts`, the same way Gate 1's own
 * executable fixture uses it. This script follows that precedent directly,
 * against the real database, rather than adding a product route whose only
 * purpose would be gate rehearsal.
 *
 * This script deliberately does NOT trigger the live focus broadcast --
 * that used to happen here, once, as part of setup, but the broadcast is
 * ephemeral in-process state that `BOARD_AGENT_PRESENCE_STALE_MS` (8s,
 * backend/src/server/socketPresence.ts) prunes on the next sweep. Triggering
 * it here meant it was always gone well before `gate2-record.spec.ts` --a
 * separate, later-run command per gate2-instructions.md -- ever opened a
 * socket to observe it, so that spec's privacy assertion always ran against
 * zero live events: not proof of privacy, just proof nothing was left to
 * leak. The recording spec now triggers (and re-triggers, to outlast its own
 * 25s sample window) the same real HTTP tool-call route itself, while its
 * observer socket is already listening.
 */
import { PrismaClient } from "../../src/generated/client";
import { registerAgentContext } from "../../src/agent/boardContexts";
import { createAgentRunMount } from "../../src/agent/boardMount";
import { AGENT_BOARD_EXPLORE } from "../../src/authz/agentContext";
import { gate2PresenceFixture } from "../../../e2e/tests/fixtures/agentContextGateFixtures";
import fs from "fs";
import path from "path";

const OWNER_EMAIL = process.env.GATE_OWNER_EMAIL;

const frameOf = (id: string, label: string, index: number) => ({
  id,
  type: "frame",
  name: label,
  x: index * 1200,
  y: 0,
  width: 800,
  height: 600,
  angle: 0,
  isDeleted: false,
});

const main = async () => {
  if (!OWNER_EMAIL) {
    throw new Error("Set GATE_OWNER_EMAIL to an existing account's email before running this.");
  }
  const prisma = new PrismaClient();
  const owner = await prisma.user.findUniqueOrThrow({ where: { email: OWNER_EMAIL } });

  const frames = gate2PresenceFixture.contexts.map((context, index) =>
    frameOf(context.frameElementId, context.label, index),
  );
  const drawing = await prisma.drawing.create({
    data: {
      name: gate2PresenceFixture.drawingName,
      elements: JSON.stringify(frames),
      appState: "{}",
      files: "{}",
      userId: owner.id,
    },
  });

  const contextIdByFixtureId = new Map<string, string>();
  for (const context of gate2PresenceFixture.contexts) {
    const registered = await registerAgentContext({
      prisma,
      drawingId: drawing.id,
      frameElementId: context.frameElementId,
    });
    contextIdByFixtureId.set(context.contextId, registered.id);
  }

  const mountInfo: Record<string, { runId: string; capabilityToken: string; contextId: string }> =
    {};

  for (const agent of gate2PresenceFixture.publicAgents) {
    const contextId = contextIdByFixtureId.get(agent.contextId)!;
    const mount = await createAgentRunMount({
      prisma,
      drawingId: drawing.id,
      runId: agent.runId,
      allowedContextIds: [contextId],
      capabilities: [AGENT_BOARD_EXPLORE],
      displayName: agent.displayName,
      audience: { kind: "drawing" },
    });
    mountInfo[agent.runId] = {
      runId: agent.runId,
      capabilityToken: mount.capabilityToken,
      contextId,
    };
  }

  const privateContextId = contextIdByFixtureId.get(gate2PresenceFixture.privateAgent.contextId)!;
  const privateMount = await createAgentRunMount({
    prisma,
    drawingId: drawing.id,
    runId: gate2PresenceFixture.privateAgent.runId,
    allowedContextIds: [privateContextId],
    capabilities: [AGENT_BOARD_EXPLORE],
    displayName: gate2PresenceFixture.privateAgent.displayName,
    audience: { kind: "private", userId: owner.id },
  });
  mountInfo[gate2PresenceFixture.privateAgent.runId] = {
    runId: gate2PresenceFixture.privateAgent.runId,
    capabilityToken: privateMount.capabilityToken,
    contextId: privateContextId,
  };

  const state = {
    drawingId: drawing.id,
    boardUrl: `${(process.env.FRONTEND_URL || "http://localhost:6767").replace(/\/$/, "")}/editor/${drawing.id}`,
    ownerUserId: owner.id,
    contexts: Object.fromEntries(contextIdByFixtureId),
    mounts: mountInfo,
  };
  const outDir = path.resolve(__dirname, "output");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "gate2-state.json");
  fs.writeFileSync(outPath, JSON.stringify(state, null, 2));

  console.log(`Gate 2 board ready: ${state.boardUrl}`);
  console.log(`State written to ${outPath} (consumed by the e2e observer/screenshot spec).`);
  console.log(
    "Reminder: this does NOT yet broadcast live focus presence -- " +
      "gate2-record.spec.ts triggers and sustains that itself while its " +
      "observer socket is listening. Board status text will read the " +
      "product's real vocabulary (e.g. \"reading\"), not the fixture's " +
      '"working"/"waiting" words -- see gate2-instructions.md.',
  );
  await prisma.$disconnect();
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
