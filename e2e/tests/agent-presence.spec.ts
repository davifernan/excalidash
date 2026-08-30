import { expect, test, type Page } from "@playwright/test";
import { createDrawing, deleteDrawing } from "./helpers/api";
import { openEditor } from "./helpers/editor";

type AgentPresenceEntry = {
  agentId: string;
  runId: string;
  drawingId: string;
  revisionId: string;
  displayName: string;
  color: string;
  status: "working";
  targetIds: readonly string[];
  focusActive: true;
  visibility: "drawing";
};

const receiveSocketEvent = (page: Page, event: string, payload: unknown) =>
  page.evaluate(
    ({ eventName, eventPayload }) => {
      const status = (window as any).__EXCALIDASH_SOCKET_STATUS__;
      if (typeof status?.receiveTestEvent !== "function") {
        throw new Error("Agent Presence socket test seam is unavailable");
      }
      status.receiveTestEvent(eventName, eventPayload);
    },
    { eventName: event, eventPayload: payload },
  );

test.describe("visible board Agent Presence", () => {
  test("keeps three named agents attached to three current Contexts", async ({ page, request }) => {
    const drawing = await createDrawing(request, { name: "NIL-672 Agent Presence" });
    try {
      await openEditor(page, drawing.id, { settleMs: 500 });
      await page.getByTestId("main-menu-trigger").click();
      await page.getByText("Insert: Brainstorming").click();

      const frames = await page.evaluate(() => {
        const api = (window as any).__EXCALIDASH_TEST__;
        const frameElements = api
          .getSceneElements()
          .filter((element: any) => element.type === "frame")
          .slice(0, 3);
        api.showViewportBounds([
          Math.min(...frameElements.map((frame: any) => frame.x)),
          Math.min(...frameElements.map((frame: any) => frame.y)) - 120,
          Math.max(...frameElements.map((frame: any) => frame.x + frame.width)),
          Math.max(...frameElements.map((frame: any) => frame.y + frame.height)),
        ]);
        return frameElements.map((frame: any) => ({ id: frame.id, name: frame.name }));
      });
      expect(frames.map((frame: { id: string; name: string }) => frame.name)).toEqual([
        "1. Ideas",
        "2. Group & Theme",
        "3. Vote & Prioritize",
      ]);

      await expect
        .poll(
          () =>
            page.evaluate(() => (window as any).__EXCALIDASH_SOCKET_STATUS__?.roomJoined === true),
          { timeout: 15_000 },
        )
        .toBe(true);

      const agents: AgentPresenceEntry[] = [
        {
          agentId: "run-research",
          runId: "run-research",
          drawingId: drawing.id,
          revisionId: "revision-gate-2",
          displayName: "Research",
          color: "#7c3aed",
          status: "working",
          targetIds: [frames[0].id],
          focusActive: true,
          visibility: "drawing",
        },
        {
          agentId: "run-design",
          runId: "run-design",
          drawingId: drawing.id,
          revisionId: "revision-gate-2",
          displayName: "Design",
          color: "#0891b2",
          status: "working",
          targetIds: [frames[1].id],
          focusActive: true,
          visibility: "drawing",
        },
        {
          agentId: "run-qa",
          runId: "run-qa",
          drawingId: drawing.id,
          revisionId: "revision-gate-2",
          displayName: "QA",
          color: "#d97706",
          status: "working",
          targetIds: [frames[2].id],
          focusActive: true,
          visibility: "drawing",
        },
      ];

      for (let count = 1; count <= agents.length; count += 1) {
        await receiveSocketEvent(page, "agent.presence.updated", agents.slice(0, count));
        await expect(page.getByTestId("agent-presence-highlight")).toHaveCount(count);
        await page.waitForTimeout(450);
      }

      for (const [index, agent] of agents.entries()) {
        const highlight = page.locator(
          `[data-testid="agent-presence-highlight"][data-target-id="${frames[index].id}"]`,
        );
        await expect(highlight).toContainText(`${agent.displayName} · reading`);
        await expect(highlight).toHaveAttribute("data-revision-id", "revision-gate-2");
      }

      await receiveSocketEvent(page, "agent.focus.finished", {
        ...agents[0],
        phase: "finished",
        occurredAt: new Date().toISOString(),
      });
      await page.waitForTimeout(1_350);
      await expect(page.getByText("Research · reading")).toHaveCount(0);
      await expect(page.getByText("Design · reading")).toBeVisible();
      await expect(page.getByText("QA · reading")).toBeVisible();
    } finally {
      await deleteDrawing(request, drawing.id).catch(() => undefined);
    }
  });
});
