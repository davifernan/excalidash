import { expect, test, type Page } from "@playwright/test";
import { createDrawing, deleteDrawing } from "./helpers/api";

const interactiveCanvas = (page: Page) => page.locator("canvas.excalidraw__canvas.interactive");

const collaboratorState = (page: Page, presenceId: string) =>
  page.evaluate((id) => {
    const collaborator = (window as any).__EXCALIDASH_EXCALIDRAW_API__
      ?.getAppState()
      .collaborators.get(id);
    if (!collaborator) return null;
    return {
      username: collaborator.username ?? null,
      color: collaborator.color?.background ?? null,
      avatarUrl: collaborator.avatarUrl ?? null,
      isActive: collaborator.isActive,
      userState: collaborator.userState ?? null,
      pointer: collaborator.pointer
        ? {
            x: collaborator.pointer.x,
            y: collaborator.pointer.y,
            tool: collaborator.pointer.tool,
            renderCursor: collaborator.pointer.renderCursor ?? null,
          }
        : null,
    };
  }, presenceId);

const sampleCursorX = (page: Page, presenceId: string) =>
  page.evaluate(
    ({ id, durationMs }) =>
      new Promise<number[]>((resolve) => {
        const samples: number[] = [];
        const startedAt = performance.now();
        const sample = () => {
          const pointer = (window as any).__EXCALIDASH_EXCALIDRAW_API__
            ?.getAppState()
            .collaborators.get(id)?.pointer;
          if (typeof pointer?.x === "number") samples.push(pointer.x);
          if (performance.now() - startedAt < durationMs) requestAnimationFrame(sample);
          else resolve(samples);
        };
        sample();
      }),
    { id: presenceId, durationMs: 220 },
  );

test("inactive presence and follow survive visual expiry, then leave without a ghost", async ({
  browser,
  request,
}, testInfo) => {
  test.setTimeout(90_000);
  const drawing = await createDrawing(request, { name: `Presence_Grace_${Date.now()}` });
  const observerContext = await browser.newContext();
  const peerContext = await browser.newContext();
  const observerPage = await observerContext.newPage();
  const peerPage = await peerContext.newPage();
  let peerClosed = false;

  try {
    await Promise.all([
      observerPage.goto(`/editor/${drawing.id}`),
      peerPage.goto(`/editor/${drawing.id}`),
    ]);
    await Promise.all([
      observerPage.waitForFunction(() => Boolean((window as any).__EXCALIDASH_EXCALIDRAW_API__)),
      peerPage.waitForFunction(() => Boolean((window as any).__EXCALIDASH_EXCALIDRAW_API__)),
    ]);
    await expect(observerPage.locator(".UserList__collaborator .Avatar")).toHaveCount(1);

    const peerPresenceId = await observerPage.evaluate(
      () =>
        Array.from(
          (window as any).__EXCALIDASH_EXCALIDRAW_API__.getAppState().collaborators.keys(),
        )[0] as string,
    );
    const activeColor = (await collaboratorState(observerPage, peerPresenceId))?.color;
    expect(activeColor).toBeTruthy();
    const followTargetId = () =>
      observerPage.evaluate(
        () =>
          (window as any).__EXCALIDASH_EXCALIDRAW_API__?.getAppState().userToFollow?.socketId ??
          null,
      );
    await observerPage.locator(".UserList__collaborator").click();
    await expect.poll(followTargetId).toBe(peerPresenceId);
    await expect(observerPage.locator('[data-follow-viewport="frame"]')).toBeVisible();

    const canvasBox = await interactiveCanvas(peerPage).boundingBox();
    if (!canvasBox) throw new Error("Peer canvas not found");
    await peerPage.mouse.move(canvasBox.x + 260, canvasBox.y + 220);
    await expect
      .poll(async () => (await collaboratorState(observerPage, peerPresenceId))?.pointer)
      .not.toBeNull();
    await peerPage.waitForTimeout(120);

    const cursorSamplesPromise = sampleCursorX(observerPage, peerPresenceId);
    await peerPage.waitForTimeout(40);
    await peerPage.mouse.move(canvasBox.x + 700, canvasBox.y + 420);
    const cursorSamples = await cursorSamplesPromise;
    const distinctCursorX = new Set(cursorSamples.map((value) => Math.round(value * 10) / 10));
    expect(distinctCursorX.size).toBeGreaterThanOrEqual(3);
    expect(Math.max(...cursorSamples) - Math.min(...cursorSamples)).toBeGreaterThan(100);

    const lastPointer = (await collaboratorState(observerPage, peerPresenceId))?.pointer;
    expect(lastPointer).not.toBeNull();
    await peerPage.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect
      .poll(async () => (await collaboratorState(observerPage, peerPresenceId))?.isActive)
      .toBe(false);
    expect((await collaboratorState(observerPage, peerPresenceId))?.color).toBe(activeColor);

    await expect
      .poll(async () => (await collaboratorState(observerPage, peerPresenceId))?.color, {
        timeout: 8_000,
      })
      .toBe("#94a3b8");
    expect((await collaboratorState(observerPage, peerPresenceId))?.pointer).toEqual(lastPointer);
    expect((await collaboratorState(observerPage, peerPresenceId))?.userState).toBe("away");
    await expect(observerPage.locator(".UserList__collaborator .Avatar-img")).toHaveAttribute(
      "src",
      /^data:image\/svg\+xml;charset=utf-8,/,
    );
    const screenshotPath = testInfo.outputPath("inactive-collaborator.png");
    await observerPage.screenshot({ path: screenshotPath });
    await testInfo.attach("inactive-collaborator", {
      path: screenshotPath,
      contentType: "image/png",
    });

    // Visual expiry must not become connection expiry. The avatar and cursor
    // leave the picture after 30 seconds, while the map entry keeps Excalidraw
    // from interpreting a tab switch as an UNFOLLOW.
    await expect(observerPage.locator(".UserList__collaborator .Avatar")).toHaveCount(0, {
      timeout: 35_000,
    });
    const visuallyExpired = await collaboratorState(observerPage, peerPresenceId);
    expect(visuallyExpired?.username).toBe("");
    expect(visuallyExpired?.pointer?.renderCursor).toBe(false);
    await expect.poll(followTargetId).toBe(peerPresenceId);
    await expect(observerPage.locator('[data-follow-viewport="frame"]')).toBeVisible();

    await peerPage.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect
      .poll(async () => (await collaboratorState(observerPage, peerPresenceId))?.isActive)
      .toBe(true);
    expect((await collaboratorState(observerPage, peerPresenceId))?.color).toBe(activeColor);
    await expect(observerPage.locator(".UserList__collaborator .Avatar")).toHaveCount(1);
    await expect.poll(followTargetId).toBe(peerPresenceId);

    await peerContext.close();
    peerClosed = true;
    await expect.poll(() => collaboratorState(observerPage, peerPresenceId)).toBeNull();
    await expect.poll(followTargetId).toBeNull();
    await expect(observerPage.locator(".UserList__collaborator .Avatar")).toHaveCount(0);
    await expect(
      observerPage.getByText("The person you were following disconnected. Follow mode ended."),
    ).toBeVisible();
  } finally {
    await observerContext.close();
    if (!peerClosed) await peerContext.close();
    await deleteDrawing(request, drawing.id);
  }
});
