import { expect, test, type Page } from "@playwright/test";
import { createDrawing, deleteDrawing } from "./helpers/api";
import { openEditor } from "./helpers/editor";

type RemoteCursor = {
  id: string;
  name: string;
  color: string | null;
  pointer: { x: number; y: number } | null;
};

const interactiveCanvas = (page: Page) => page.locator("canvas.excalidraw__canvas.interactive");

const remoteCursors = (page: Page): Promise<RemoteCursor[]> =>
  page.evaluate(() => {
    const api = (window as any).__EXCALIDASH_TEST__;
    return [...api.getAppState().collaborators.entries()].map(([id, collaborator]: any) => ({
      id,
      name: collaborator.name ?? collaborator.username ?? "",
      color:
        typeof collaborator.color === "string"
          ? collaborator.color
          : (collaborator.color?.background ?? null),
      pointer: collaborator.pointer ?? null,
    }));
  });

const pointedCursors = async (page: Page): Promise<RemoteCursor[]> =>
  (await remoteCursors(page))
    .filter((cursor) => cursor.pointer !== null)
    .sort((left, right) => left.pointer!.x - right.pointer!.x);

const greyMix20 = (color: string): string => {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16));
  const grey = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  return `#${channels
    .map((channel) =>
      Math.round(channel * 0.8 + grey * 0.2)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
};

test("active and away cursors stay identifiable in light and dark themes, then reset", async ({
  browser,
  request,
}, testInfo) => {
  const drawing = await createDrawing(request, { name: `Away presence ${Date.now()}` });
  const contexts = await Promise.all(
    Array.from({ length: 4 }, () => browser.newContext({ viewport: { width: 1280, height: 720 } })),
  );
  const [activeContext, awayContext, lightObserverContext, darkObserverContext] = contexts;
  await darkObserverContext.addInitScript(() => localStorage.setItem("theme", "dark"));

  try {
    const [activePeer, awayPeer, lightObserver, darkObserver] = await Promise.all(
      contexts.map(async (context) => openEditor(await context.newPage(), drawing.id)),
    );
    await expect(lightObserver.locator("html")).not.toHaveClass(/dark/);
    await expect(darkObserver.locator("html")).toHaveClass(/dark/);

    const activeBox = await interactiveCanvas(activePeer).boundingBox();
    const awayBox = await interactiveCanvas(awayPeer).boundingBox();
    if (!activeBox || !awayBox) throw new Error("Interactive canvases were not measurable");
    await activePeer.mouse.move(activeBox.x + 350, activeBox.y + 260);
    await awayPeer.mouse.move(awayBox.x + 800, awayBox.y + 430);

    await expect
      .poll(async () => (await pointedCursors(lightObserver)).length, { timeout: 10_000 })
      .toBe(2);
    await expect
      .poll(async () => (await pointedCursors(darkObserver)).length, { timeout: 10_000 })
      .toBe(2);

    const activePair = await pointedCursors(lightObserver);
    const activeState = activePair[1];
    expect(activeState.name).not.toContain("away");
    expect(activeState.name.length).toBeGreaterThan(0);
    expect(activeState.color).toMatch(/^#[0-9a-f]{6}$/i);

    await awayPeer.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect
      .poll(async () => (await pointedCursors(lightObserver))[1]?.name, { timeout: 8_000 })
      .toBe(`${activeState.name} · away`);
    await expect
      .poll(async () => (await pointedCursors(darkObserver))[1]?.name, { timeout: 8_000 })
      .toBe(`${activeState.name} · away`);

    for (const observer of [lightObserver, darkObserver]) {
      const [stillActive, away] = await pointedCursors(observer);
      expect(stillActive.name).not.toContain("away");
      expect(stillActive.name.length).toBeGreaterThan(0);
      expect(away.name).toBe(`${activeState.name} · away`);
      expect(away.pointer).toEqual(activeState.pointer);
    }

    await lightObserver.screenshot({ path: testInfo.outputPath("away-presence-light.png") });
    await darkObserver.screenshot({ path: testInfo.outputPath("away-presence-dark.png") });

    for (const observer of [lightObserver, darkObserver]) {
      const away = (await pointedCursors(observer))[1];
      expect(away.color).toBe(greyMix20(activeState.color!));
      expect(away.color).not.toBe(activeState.color);
    }

    await awayPeer.evaluate(() => window.dispatchEvent(new Event("focus")));
    for (const observer of [lightObserver, darkObserver]) {
      await expect
        .poll(async () => (await pointedCursors(observer))[1]?.name, { timeout: 8_000 })
        .toBe(activeState.name);
      const returned = (await pointedCursors(observer))[1];
      expect(returned.color).toBe(activeState.color);
      expect(returned.pointer).toEqual(activeState.pointer);
    }
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    await deleteDrawing(request, drawing.id).catch(() => {});
  }
});
