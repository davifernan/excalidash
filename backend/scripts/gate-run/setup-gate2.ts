/**
 * NIL-701 stage setup for Gate 2 (visible Agent Presence). Builds none of the
 * gate's judgment -- it only makes `gate2PresenceFixture`
 * (e2e/tests/fixtures/agentContextGateFixtures.ts) exist as real rows and a
 * real, live-broadcast focus state on whatever backend DATABASE_URL/API_URL
 * this script is pointed at. Run it against the SAME database and the SAME
 * running server process Davi will open in his browser -- it does not start
 * a server itself.
 *
 * Usage (from backend/):
 *   GATE_OWNER_EMAIL=owner@example.com \
 *   API_URL=http://localhost:8000 \
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
 * Focus presence IS reachable over HTTP (`POST .../mounts/:runId/tools/:tool`),
 * because that route already exists for real agent tool calls. This script
 * calls it for real, against the already-running server, so the resulting
 * focus broadcast is the exact production code path, not a stand-in.
 */
import { PrismaClient } from "../../src/generated/client";
import { registerAgentContext } from "../../src/agent/boardContexts";
import { createAgentRunMount } from "../../src/agent/boardMount";
import { AGENT_BOARD_EXPLORE } from "../../src/authz/agentContext";
import { gate2PresenceFixture } from "../../../e2e/tests/fixtures/agentContextGateFixtures";
import { config } from "../../src/config";
import jwt from "jsonwebtoken";
import fs from "fs";
import path from "path";

const API_URL = process.env.API_URL || "http://localhost:8000";
const OWNER_EMAIL = process.env.GATE_OWNER_EMAIL;

/**
 * CSRF here is a blanket double-submit-cookie policy with no exemption for
 * token-authenticated agent routes -- a real external runtime calling this
 * same tool-call endpoint would need to do exactly this handshake too, so
 * this is the production shape, not a workaround around it.
 */
const fetchCsrf = async (): Promise<{ header: string; token: string; cookie: string }> => {
  const response = await fetch(`${API_URL}/csrf-token`);
  if (!response.ok) throw new Error(`CSRF fetch failed: HTTP ${response.status}`);
  const body = (await response.json()) as { token: string; header?: string };
  const setCookie = response.headers.get("set-cookie") || "";
  const cookie = setCookie.split(";")[0] || "";
  return { header: body.header || "x-csrf-token", token: body.token, cookie };
};

const frameOf = (id: string, index: number) => ({
  id,
  type: "frame",
  name: id,
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
    frameOf(context.frameElementId, index),
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

  // Trigger genuine focus broadcast for the four runs by making the exact
  // same HTTP call a real agent tool call makes, against the already-running
  // server -- this is the one piece of state that lives only in that
  // process's memory, not the database, so it cannot be seeded any other
  // way. Status text is deliberately NOT claimed to say "working"/"waiting"
  // here -- see gate2-instructions.md's flagged finding.
  // The tool-call route requires the caller to ALSO already have ordinary
  // view access to the drawing -- the mount token alone is not enough, by
  // design (a mount narrows an already-authorized viewer, it does not grant
  // access on its own). A real external runtime would carry the owner's or
  // an authorized viewer's session; this mints the same JWT shape the rest
  // of this codebase's own tests use for exactly that reason.
  const ownerToken = jwt.sign(
    { userId: owner.id, email: owner.email, type: "access" },
    config.jwtSecret,
    { expiresIn: config.jwtAccessExpiresIn as any },
  );

  const csrf = await fetchCsrf();
  const allRuns = [...gate2PresenceFixture.publicAgents, gate2PresenceFixture.privateAgent];
  for (const agent of allRuns) {
    const info = mountInfo[agent.runId];
    const frameElementId = gate2PresenceFixture.contexts.find(
      (c) => c.contextId === agent.contextId,
    )!.frameElementId;
    const response = await fetch(
      `${API_URL}/drawings/${drawing.id}/agent/mounts/${info.runId}/tools/readFrame`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${ownerToken}`,
          "x-agent-mount-token": info.capabilityToken,
          [csrf.header]: csrf.token,
          cookie: csrf.cookie,
        },
        body: JSON.stringify({ frameElementId }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Focus trigger for ${agent.runId} failed: HTTP ${response.status} ${await response.text()}`,
      );
    }
  }

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
    'Reminder: board status text will read the product\'s real vocabulary (e.g. "reading"), ' +
      'not the fixture\'s "working"/"waiting" words -- see gate2-instructions.md.',
  );
  await prisma.$disconnect();
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
