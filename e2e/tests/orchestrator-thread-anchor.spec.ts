import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createDrawing, deleteDrawing, getDrawing } from "./helpers/api";
import { openEditor, scene } from "./helpers/editor";

const openMenu = async (page: Page) => {
  await page.getByTestId("main-menu-trigger").click();
};

const expectInside = async (
  inner: ReturnType<Page["getByText"]>,
  outer: ReturnType<Page["getByTestId"]>,
) => {
  const [innerBox, outerBox] = await Promise.all([inner.boundingBox(), outer.boundingBox()]);
  expect(innerBox).not.toBeNull();
  expect(outerBox).not.toBeNull();
  expect(innerBox!.y).toBeGreaterThanOrEqual(outerBox!.y);
  expect(innerBox!.y + innerBox!.height).toBeLessThanOrEqual(outerBox!.y + outerBox!.height);
};

test.describe("Orchestrator Thread Board Card (NIL-678)", () => {
  let drawingId: string;
  let api: APIRequestContext;

  test.beforeEach(async ({ request }) => {
    api = request;
    const drawing = await createDrawing(request, { name: `NIL-678 thread ${Date.now()}` });
    drawingId = drawing.id;
  });

  test.afterEach(async () => {
    if (drawingId) await deleteDrawing(api, drawingId).catch(() => {});
  });

  test("persists the anchor, opens one panel, and docks when the anchor becomes unreadable", async ({
    page,
  }, testInfo) => {
    await openEditor(page, drawingId);
    const invitation = page.getByTestId("orchestrator-thread-invitation");
    await expect(invitation).toBeVisible();
    await expect(invitation).toContainText("Where should we coordinate?");
    await page.screenshot({ path: testInfo.outputPath("empty-board-invitation.png") });
    await page.getByRole("button", { name: "Place shared thread here" }).click();
    await expect(invitation).toHaveCount(0);

    const panel = page.getByTestId("orchestrator-thread-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute("data-mode", "anchored");
    await expect(panel).toContainText("No orchestrator events yet");
    await expect(page.getByTestId("orchestrator-thread-panel")).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath("anchored-thread-panel.png") });

    // A zoom that makes the Board Card unreadably small changes the OPEN
    // state to docked. It does not turn the feature into an always-present
    // sidebar: the panel names the unreachable anchor and offers a jump.
    const zoomOut = page.getByRole("button", { name: "Zoom out" });
    for (let step = 0; step < 6; step += 1) await zoomOut.click();
    await expect(panel).toHaveAttribute("data-mode", "docked");
    await expect(panel.getByText(/Anchor outside the readable view/)).toBeVisible();

    await page.getByRole("button", { name: "Reset zoom" }).click();
    await expect(panel).toHaveAttribute("data-mode", "anchored");

    // Wait for ordinary board persistence, then prove a fresh editor mount
    // rediscovers the shared Board Card rather than reconstructing local UI.
    await expect
      .poll(async () => {
        const drawing = await getDrawing(api, drawingId);
        return (drawing.elements ?? []).some(
          (element) => element.customData?.excalidash?.orchestratorThread?.threadId,
        );
      })
      .toBe(true);

    await page.reload();
    await page.waitForSelector("canvas");
    await page.waitForFunction(() => !!(window as any).__EXCALIDASH_TEST__);
    const card = page.getByTestId("orchestrator-thread-card");
    await expect(card).toHaveCount(1);
    await expect(card).toBeVisible();
    await expect(panel).toHaveCount(0);

    // The visual overlay must not turn the persisted Excalidraw Board Card
    // into an immovable DOM widget. Dragging through the overlay moves the
    // actual shared element; only its small Open control captures input.
    const beforeDrag = await card.boundingBox();
    if (!beforeDrag) throw new Error("thread Board Card has no browser bounds");
    await page.mouse.move(
      beforeDrag.x + beforeDrag.width / 2,
      beforeDrag.y + beforeDrag.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      beforeDrag.x + beforeDrag.width / 2 + 100,
      beforeDrag.y + beforeDrag.height / 2 + 60,
      { steps: 8 },
    );
    await page.mouse.up();
    await expect
      .poll(async () => (await card.boundingBox())?.x ?? beforeDrag.x)
      .toBeGreaterThan(beforeDrag.x + 60);

    await page.getByRole("button", { name: /Open Orchestrator/ }).click();
    await expect(panel).toHaveCount(1);
    await expect(panel).toHaveAttribute("data-mode", "anchored");

    // Creating another shared anchor replaces the local open identity; there
    // is never one full panel per anchor.
    await openMenu(page);
    await page.getByTestId("menu-new-orchestrator-thread").click();
    await expect(page.getByTestId("orchestrator-thread-panel")).toHaveCount(1);
  });

  test("keeps ordinary canvas drawing available through the empty-board invitation", async ({
    page,
  }) => {
    await openEditor(page, drawingId);
    const invitation = page.getByTestId("orchestrator-thread-invitation");
    await expect(invitation).toBeVisible();

    // The invitation is visual guidance, not a modal surface. A normal canvas
    // gesture that starts over its body must still reach Excalidraw. Check the
    // whole DOM subtree rather than one lucky point: only explicit controls may
    // opt back into pointer handling when another control is added later.
    const pointerContract = await invitation.evaluate((surface) => {
      const interactiveSelector = "button, a[href], input, select, textarea, [role='button']";
      const controls = Array.from(surface.querySelectorAll<HTMLElement>(interactiveSelector));
      const leaks = [surface, ...Array.from(surface.querySelectorAll<HTMLElement>("*"))]
        .filter(
          (element) =>
            !controls.some((control) => control === element || control.contains(element)) &&
            getComputedStyle(element).pointerEvents !== "none",
        )
        .map((element) => ({
          tag: element.tagName.toLowerCase(),
          className: element.className,
        }));
      return {
        leaks,
        controls: controls.map((control) => ({
          text: control.textContent?.trim() ?? "",
          pointerEvents: getComputedStyle(control).pointerEvents,
        })),
      };
    });
    expect(pointerContract.leaks).toEqual([]);
    expect(pointerContract.controls).toEqual([
      { text: "Place shared thread here", pointerEvents: "auto" },
      { text: "Start a local thread", pointerEvents: "auto" },
    ]);

    const invitationBox = await invitation.boundingBox();
    expect(invitationBox).not.toBeNull();
    const invitationCenter = {
      x: invitationBox!.x + invitationBox!.width / 2,
      y: invitationBox!.y + invitationBox!.height / 2,
    };
    const gestureEnd = {
      x: invitationCenter.x + 180,
      y: invitationCenter.y + 80,
    };

    // Both the focus click and the drawing gesture start at the measured
    // centre of the invitation. This is a pass-through assertion, not a click
    // on conveniently empty canvas beside the surface under test.
    expect(
      await page.evaluate(
        ({ x, y }) => document.elementFromPoint(x, y)?.tagName.toLowerCase(),
        invitationCenter,
      ),
    ).toBe("canvas");
    await page.mouse.click(invitationCenter.x, invitationCenter.y);
    await page.keyboard.press("r");
    await page.mouse.move(invitationCenter.x, invitationCenter.y);
    await page.mouse.down();
    await page.mouse.move(gestureEnd.x, gestureEnd.y, { steps: 8 });
    await page.mouse.up();

    await expect
      .poll(
        async () =>
          (await scene(page)).filter((element: any) => element.type === "rectangle").length,
      )
      .toBe(1);
    await expect(invitation).toHaveCount(0);
  });

  test("keeps local and multiplayer histories separate across a reload", async ({
    page,
  }, testInfo) => {
    await openEditor(page, drawingId);
    await page.getByRole("button", { name: "Start a local thread" }).click();
    const panel = page.getByTestId("orchestrator-thread-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("button", { name: "Local" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await panel.getByLabel("Message this audience").fill("private-device-history");
    await panel.getByRole("button", { name: "Send message" }).click();
    const privateMessage = panel.getByText("private-device-history");
    await expect(privateMessage).toBeVisible();
    await expectInside(privateMessage, panel.locator(".orchestrator-thread-panel__events"));
    await page.screenshot({ path: testInfo.outputPath("local-thread-history.png") });

    await page.reload();
    await page.waitForSelector("canvas");
    await page.waitForFunction(() => !!(window as any).__EXCALIDASH_TEST__);
    await page.getByRole("button", { name: "Open Local orchestrator thread" }).click();
    await expect(panel.getByText("private-device-history")).toBeVisible();
    await panel.getByRole("button", { name: "Close orchestrator thread" }).click();

    await page.getByRole("button", { name: "Place shared thread here" }).click();
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("button", { name: "Multiplayer" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await panel.getByLabel("Message this audience").fill("shared-board-history");
    await panel.getByRole("button", { name: "Send message" }).click();
    const sharedMessage = panel.getByText("shared-board-history");
    await expect(sharedMessage).toBeVisible();
    await expectInside(sharedMessage, panel.locator(".orchestrator-thread-panel__events"));
    await expect(panel.getByText("private-device-history")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("multiplayer-thread-history.png") });

    await panel.getByRole("button", { name: "Local" }).click();
    await expect(panel.getByText("private-device-history")).toBeVisible();
    await expect(panel.getByText("shared-board-history")).toHaveCount(0);
    await panel.getByRole("button", { name: "Multiplayer" }).click();
    await expect(panel.getByText("shared-board-history")).toBeVisible();
    await expect(panel.getByText("private-device-history")).toHaveCount(0);
  });

  test("shows a public receipt without claiming that runtime completion is board effect", async ({
    page,
  }, testInfo) => {
    let dispatchedBody: Record<string, unknown> | null = null;
    await page.route(`**/drawings/${drawingId}/agent/runtime`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          connections: [
            {
              id: "runtime-1",
              label: "Local runtime",
              audience: { kind: "installation" },
              costBearer: { label: "Instance operator" },
              profiles: [{ id: "review", label: "Review" }],
              health: { connected: true, status: "connected" },
            },
          ],
        }),
      });
    });
    await page.route(`**/drawings/${drawingId}/instruction-contexts`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ contexts: [{ id: "context-1", frameElementId: "Decision frame" }] }),
      });
    });
    await page.route(
      `**/drawings/${drawingId}/orchestrator-threads/*/dispatches`,
      async (route) => {
        if (route.request().method() === "GET") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: '{"receipts":[]}',
          });
          return;
        }
        dispatchedBody = route.request().postDataJSON();
        await route.fulfill({
          status: 202,
          contentType: "application/json",
          body: JSON.stringify({
            receipt: {
              id: "receipt-1",
              drawingId,
              publicThreadId: (dispatchedBody as any).publicThreadId,
              originVisibility: "private",
              objectiveSummary: (dispatchedBody as any).objectiveSummary,
              targetContextIds: ["context-1"],
              revisionId: "revision-1",
              effectiveCapabilities: ["agent:run", "board:write"],
              expectedArtifacts: ["Board update"],
              runId: "run-1",
              admission: "accepted",
              execution: "succeeded",
              effect: "pending",
              executionReason: null,
              costBearer: { label: "Instance operator" },
              acceptedAt: "2026-08-30T03:00:00.000Z",
              lastObservedAt: "2026-08-30T03:01:00.000Z",
              effectEvidence: null,
            },
          }),
        });
      },
    );

    await openEditor(page, drawingId);
    await page.getByRole("button", { name: "Start a local thread" }).click();
    const panel = page.getByTestId("orchestrator-thread-panel");
    await panel.getByLabel("Message this audience").fill("private-token-LEAKME-NIL679");
    await panel.getByRole("button", { name: "Send message" }).click();
    await expect(panel.getByText("private-token-LEAKME-NIL679")).toBeVisible();
    await panel.getByRole("button", { name: "Close orchestrator thread" }).click();
    await page.getByRole("button", { name: "Place shared thread here" }).click();
    await panel.getByRole("button", { name: "Local" }).click();

    await panel.getByRole("button", { name: "Approve a public effect" }).click();
    const publicThread = panel.getByLabel("Public responsibility thread");
    await expect(publicThread).toHaveValue("");
    await expect(publicThread.locator("option")).toHaveCount(2);
    await publicThread.selectOption({ index: 1 });
    await expect(publicThread).not.toHaveValue("");
    await panel.getByLabel("Approved public objective").fill("Publish the approved comparison");
    await panel.getByLabel("Public effect Context").selectOption("context-1");
    await panel.getByLabel("Agent runtime connection").selectOption("runtime-1");
    await expect(
      panel.getByText("This dispatch uses Local runtime and is charged to Instance operator."),
    ).toBeVisible();
    await panel.getByLabel("Agent runtime profile").selectOption("review");
    await panel
      .getByRole("button", { name: "Dispatch via Local runtime · charged to Instance operator" })
      .click();

    const pendingEffect = panel.getByText("Execution finished · publication pending");
    await expect(pendingEffect).toBeVisible();
    await expect(panel.getByText("Charged to: Instance operator")).toBeVisible();
    await expect(panel.getByText("Effect confirmed on the board")).toHaveCount(0);
    expect(JSON.stringify(dispatchedBody)).not.toContain("private-token-LEAKME-NIL679");
    await page.screenshot({
      path: testInfo.outputPath("dispatch-receipt-publication-pending.png"),
    });
  });
});
