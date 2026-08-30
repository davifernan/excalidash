/**
 * NIL-701 stage setup for Gate 3 (Board-Faden vs. Terminal). Unlike Gate 2,
 * nothing here needs to be broadcast live: Davi reads persisted content by
 * opening the board, so this only needs to be real database state, written
 * directly via the same backend modules Gate 1's own executable fixture
 * uses (`registerAgentContext`) plus the real orchestrator-thread modules
 * (`registerDrawingOrchestratorThread`, `appendOrchestratorThreadMessage`).
 * No HTTP call in this script -- there is no ephemeral state to trigger.
 *
 * Usage (from backend/):
 *   GATE_OWNER_EMAIL=owner@example.com \
 *   npm run gate-run:setup-gate3
 *
 * The terminal-transcript side of the comparison is not board state at all
 * -- it is a plain text file, written alongside this script's output, that
 * an operator hands Davi directly (see materials/gate3-terminal-transcript.txt).
 */
import { PrismaClient } from "../../src/generated/client";
import { registerAgentContext } from "../../src/agent/boardContexts";
import {
  registerDrawingOrchestratorThread,
  appendOrchestratorThreadMessage,
} from "../../src/agent/orchestratorThreads";
import { gate3BoardThreadFixture } from "../../../e2e/tests/fixtures/agentContextGateFixtures";
import fs from "fs";
import path from "path";

const OWNER_EMAIL = process.env.GATE_OWNER_EMAIL;
const SHARED_THREAD_ELEMENT_ID = "gate-3-shared-thread-card";

// Gate 3's fixture doesn't carry frame labels of its own (unlike Gate 2) --
// it only needs one Context per task so each task has a real place on the
// board to be "in". Reused verbatim from each task's own id.
const frameIdFor = (taskId: string) => `frame-${taskId}`;

const main = async () => {
  if (!OWNER_EMAIL) {
    throw new Error("Set GATE_OWNER_EMAIL to an existing account's email before running this.");
  }
  const prisma = new PrismaClient();
  const owner = await prisma.user.findUniqueOrThrow({ where: { email: OWNER_EMAIL } });

  const taskFrames = gate3BoardThreadFixture.tasks.map((task, index) => ({
    id: frameIdFor(task.id),
    type: "frame",
    name: frameIdFor(task.id),
    x: index * 1000,
    y: 0,
    width: 700,
    height: 500,
    angle: 0,
    isDeleted: false,
  }));
  const sharedThreadCard = {
    id: SHARED_THREAD_ELEMENT_ID,
    type: "rectangle",
    x: 0,
    y: -300,
    width: 260,
    height: 96,
    angle: 0,
    isDeleted: false,
    customData: {
      excalidash: {
        schemaVersion: 2,
        orchestratorThread: { title: "Gate 3 — Board thread" },
      },
    },
  };

  const drawing = await prisma.drawing.create({
    data: {
      name: "Gate 3 — Board thread vs. terminal",
      elements: JSON.stringify([...taskFrames, sharedThreadCard]),
      appState: "{}",
      files: "{}",
      userId: owner.id,
    },
  });

  for (const task of gate3BoardThreadFixture.tasks) {
    await registerAgentContext({
      prisma,
      drawingId: drawing.id,
      frameElementId: frameIdFor(task.id),
    });
  }

  const thread = await registerDrawingOrchestratorThread({
    prisma,
    drawingId: drawing.id,
    anchorElementId: SHARED_THREAD_ELEMENT_ID,
  });

  // One message per task, in fixture order -- content and order are fixture
  // data, not something this script may choose or reword.
  for (const task of gate3BoardThreadFixture.tasks) {
    await appendOrchestratorThreadMessage({
      prisma,
      drawingId: drawing.id,
      threadId: thread.id,
      userId: owner.id,
      displayName: "Gate 3 setup",
      text: `${task.prompt}\n${task.answer}`,
    });
  }

  const state = {
    drawingId: drawing.id,
    boardUrl: `${(process.env.FRONTEND_URL || "http://localhost:6767").replace(/\/$/, "")}/editor/${drawing.id}`,
    sharedThreadId: thread.id,
  };
  const outDir = path.resolve(__dirname, "output");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "gate3-state.json"), JSON.stringify(state, null, 2));

  console.log(`Gate 3 board ready: ${state.boardUrl}`);
  console.log(
    "Open the shared orchestrator thread there for the board-thread half of the comparison. " +
      "The terminal-transcript half is materials/gate3-terminal-transcript.txt, not board state.",
  );
  await prisma.$disconnect();
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
