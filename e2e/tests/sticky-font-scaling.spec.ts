import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { createDrawing, deleteDrawing, getDrawing } from "./helpers/api";
import { armTool, labels, openEditor } from "./helpers/editor";

/**
 * NIL-630's own Nachweispflicht, against real browser font metrics rather
 * than the unit-level jsdom stand-in (stickyFit.test.ts already covers the
 * pure math against a deterministic metrics provider): a measurement series
 * showing the shrink is continuous rather than stepped, two browser contexts
 * agreeing on the same derived size for the same content, and a real-browser
 * input-latency measurement.
 */

const placeNote = async (page: Page, at: { x: number; y: number }) => {
  await armTool(page);
  await page.locator("canvas").last().click({ position: at });
  await page.waitForFunction(() =>
    (window as any).__EXCALIDASH_TEST__
      .getSceneElements()
      .some((element: any) => element.customData?.excalidash?.sticky),
  );
};

const settle = async (page: Page) => {
  await page.waitForTimeout(400);
};

const textAt = (length: number) =>
  Array.from({ length }, (_, index) => (index % 6 === 5 ? " " : "x")).join("");

const setNote = async (page: Page, size: number, text: string) => {
  await page.evaluate(
    ({ noteSize, value }) => {
      const api = (window as any).__EXCALIDASH_TEST__;
      const elements = api.getSceneElements();
      api.updateScene({
        elements: elements.map((element: any) => {
          if (element.customData?.excalidash?.sticky) {
            const excalidash = element.customData.excalidash;
            return {
              ...element,
              width: noteSize,
              height: noteSize,
              customData: {
                ...element.customData,
                excalidash: {
                  ...excalidash,
                  sticky: { ...excalidash.sticky, width: noteSize, height: noteSize },
                },
              },
            };
          }
          return element.type === "text"
            ? { ...element, text: value, originalText: value }
            : element;
        }),
      });
    },
    { noteSize: size, value: text },
  );
  await settle(page);
};

test.describe("sticky note font scaling (NIL-630)", () => {
  let drawingId: string;
  let api: APIRequestContext;

  test.beforeEach(async ({ request }) => {
    api = request;
    const drawing = await createDrawing(request, { name: `e2e-sticky-font-${Date.now()}` });
    drawingId = drawing.id;
  });

  test.afterEach(async () => {
    if (drawingId) await deleteDrawing(api, drawingId).catch(() => {});
  });

  test("measures one content curve for small, medium, and large notes", async ({ page }) => {
    await openEditor(page, drawingId);
    await placeNote(page, { x: 400, y: 300 });
    await page.keyboard.type("x");
    await page.keyboard.press("Escape");
    await settle(page);

    const lengths = [3, 30, 300, 3000];
    const noteSizes = [120, 200, 360];
    const matrix: Array<{ noteSize: number; sizes: number[] }> = [];
    for (const noteSize of noteSizes) {
      const sizes: number[] = [];
      for (const length of lengths) {
        await setNote(page, noteSize, textAt(length));
        const [label] = await labels(page);
        sizes.push(label.fontSize);
      }
      matrix.push({ noteSize, sizes });
    }

    console.log(`NIL630_BROWSER_FONT_MATRIX=${JSON.stringify({ lengths, matrix })}`);
    for (const { sizes } of matrix) {
      expect(sizes[0]).toBeGreaterThan(sizes[1]);
      expect(sizes[1]).toBeGreaterThan(sizes[2]);
      expect(sizes[2]).toBeGreaterThanOrEqual(sizes[3]);
    }
    expect(matrix[2].sizes[0]).toBeGreaterThan(matrix[1].sizes[0]);
    expect(matrix[1].sizes[0]).toBeGreaterThan(matrix[0].sizes[0]);
  });

  test("one character in the shrinking range settles without oscillating", async ({ page }) => {
    await openEditor(page, drawingId);
    await placeNote(page, { x: 400, y: 300 });
    const textarea = page.locator("textarea.excalidraw-wysiwyg");
    await expect(textarea).toBeVisible();
    await page.keyboard.type(textAt(87), { delay: 0 });
    await settle(page);

    const sampling = page.evaluate(
      () =>
        new Promise<number[]>((resolve) => {
          const samples: number[] = [];
          let frames = 0;
          const sample = () => {
            const label = (window as any).__EXCALIDASH_TEST__
              .getSceneElements()
              .find((element: any) => element.type === "text");
            if (typeof label?.fontSize === "number") samples.push(label.fontSize);
            frames += 1;
            if (frames >= 30) resolve(samples);
            else requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        }),
    );
    await page.waitForTimeout(35);
    await page.keyboard.type("x", { delay: 0 });
    const samples = await sampling;
    console.log(`NIL630_BOUNDARY_FRAMES=${JSON.stringify(samples)}`);

    for (let index = 1; index < samples.length; index += 1) {
      expect(samples[index]).toBeLessThanOrEqual(samples[index - 1] + 0.001);
    }
    expect(new Set(samples.slice(-5)).size).toBe(1);
  });

  test("font follows a live note resize while raw events are frame-coalesced", async ({ page }) => {
    await openEditor(page, drawingId);
    await placeNote(page, { x: 400, y: 300 });
    await page.keyboard.type("tiny");
    await page.keyboard.press("Escape");
    await settle(page);

    const geometry = await page.evaluate(() => {
      const api = (window as any).__EXCALIDASH_TEST__;
      const note = api
        .getSceneElements()
        .find((element: any) => element.customData?.excalidash?.sticky);
      return {
        center: api.toViewport({ x: note.x + note.width / 2, y: note.y + note.height / 2 }),
        corner: api.toViewport({ x: note.x + note.width, y: note.y + note.height }),
      };
    });
    await page.mouse.click(geometry.center.x, geometry.center.y);
    await page.mouse.move(geometry.corner.x, geometry.corner.y);
    await page.mouse.down();

    const frames: Array<{ width: number; fontSize: number }> = [];
    for (const delta of [25, 50, 75, 100]) {
      await page.mouse.move(geometry.corner.x + delta, geometry.corner.y + delta);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      frames.push(
        await page.evaluate(() => {
          const elements = (window as any).__EXCALIDASH_TEST__.getSceneElements();
          const note = elements.find((element: any) => element.customData?.excalidash?.sticky);
          const label = elements.find((element: any) => element.type === "text");
          return { width: note.width, fontSize: label.fontSize };
        }),
      );
    }
    await page.mouse.up();
    await settle(page);
    console.log(`NIL630_RESIZE_FRAMES=${JSON.stringify(frames)}`);

    expect(new Set(frames.map(({ width }) => width)).size).toBeGreaterThan(2);
    expect(new Set(frames.map(({ fontSize }) => fontSize)).size).toBeGreaterThan(2);
    for (let index = 1; index < frames.length; index += 1) {
      expect(frames[index].fontSize).toBeGreaterThan(frames[index - 1].fontSize);
    }
  });

  test("visual: sparse and filled notes show the full font range side by side", async ({
    page,
  }, testInfo) => {
    await openEditor(page, drawingId);
    await placeNote(page, { x: 330, y: 300 });
    await page.keyboard.type("Plan");
    await page.keyboard.press("Escape");
    await placeNote(page, { x: 700, y: 300 });
    await page.keyboard.type(textAt(300), { delay: 0 });
    await page.keyboard.press("Escape");
    await settle(page);
    await page
      .locator("canvas")
      .last()
      .click({ position: { x: 1000, y: 550 } });

    const measured = (await labels(page))
      .map((label) => label.fontSize)
      .sort((left, right) => right - left);
    expect(measured[0]).toBeGreaterThan(40);
    expect(measured[1]).toBeLessThan(10);
    console.log(`NIL630_VISUAL_FONTS=${JSON.stringify(measured)}`);
    await page.screenshot({
      path: testInfo.outputPath("nil630-sparse-full.png"),
      clip: { x: 170, y: 110, width: 760, height: 410 },
    });
  });

  test("two browser contexts derive the same font size for the same content", async ({
    browser,
  }) => {
    // Keep both collaborators symmetric. Reusing the test fixture's context
    // and cloning its storage made one side inherit lifecycle/cookie state the
    // other did not have; under a full shard that could join the room yet miss
    // the authored label update. The established collaboration specs use two
    // independent contexts for exactly this reason.
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    try {
      const pageA = await contextA.newPage();
      const pageB = await contextB.newPage();

      await Promise.all([openEditor(pageA, drawingId), openEditor(pageB, drawingId)]);
      await Promise.all(
        [pageA, pageB].map((target) =>
          target.waitForFunction(
            () => (window as any).__EXCALIDASH_SOCKET_STATUS__?.roomJoined === true,
          ),
        ),
      );

      const longText =
        "Two people looking at the same note from two different browsers must see " +
        "the writing at exactly the same size, because it is derived from the note's " +
        "content and dimensions alone, never stored and synced as a separate value.";
      await placeNote(pageA, { x: 400, y: 300 });
      await pageA.keyboard.type(longText, { delay: 0 });
      await pageA.keyboard.press("Escape");

      // Wait for B to receive the synced text before reading its own derived
      // size -- B computes its own fontSize locally, it does not receive one.
      // Matched against `originalText`, not `text`: the fit pass on A already
      // rewrote `text` with the wrapped line breaks its own font size chose,
      // so the flat string never appears there again.
      await pageB.waitForFunction(
        (expected) =>
          (window as any).__EXCALIDASH_TEST__
            ?.getSceneElements()
            .some(
              (element: any) =>
                element.originalText === expected &&
                typeof element.fontSize === "number" &&
                element.fontSize !== 20,
            ) ?? false,
        longText,
      );
      await settle(pageB);

      const [labelA] = await labels(pageA);
      const [labelB] = await labels(pageB);
      console.log(
        `NIL630_COLLAB_FONTS=${JSON.stringify({ a: labelA.fontSize, b: labelB.fontSize })}`,
      );

      expect(labelA.fontSize).toBeGreaterThan(0);
      expect(labelA.fontSize).toBe(labelB.fontSize);

      const revisions = async (target: Page) =>
        target.evaluate(() => {
          const label = (window as any).__EXCALIDASH_TEST__
            .getSceneElements()
            .find((element: any) => element.type === "text");
          return {
            version: label.version,
            versionNonce: label.versionNonce,
            updated: label.updated,
            fontSize: label.fontSize,
          };
        });
      const settledA = await revisions(pageA);
      const settledB = await revisions(pageB);
      await pageA.waitForTimeout(1500);
      expect(await revisions(pageA)).toEqual(settledA);
      expect(await revisions(pageB)).toEqual(settledB);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });

  test("reload derives the visible font from canonical persisted state", async ({ page }) => {
    await openEditor(page, drawingId);
    await placeNote(page, { x: 400, y: 300 });
    const value = textAt(180);
    await page.keyboard.type(value, { delay: 0 });
    await page.keyboard.press("Escape");
    await settle(page);
    const [before] = await labels(page);
    expect(before.fontSize).not.toBe(20);
    await page.waitForTimeout(1500);

    await expect
      .poll(async () => {
        const persisted = await getDrawing(api, drawingId);
        return persisted.elements?.find((element) => element.type === "text")?.fontSize;
      })
      .toBe(20);

    await page.reload();
    await page.waitForFunction(
      (expected) =>
        (window as any).__EXCALIDASH_TEST__
          ?.getSceneElements()
          .some(
            (element: any) =>
              element.originalText === expected &&
              typeof element.fontSize === "number" &&
              element.fontSize !== 20,
          ) ?? false,
      value,
    );
    const [after] = await labels(page);
    expect(after.fontSize).toBe(before.fontSize);
  });

  test("typing into a long note stays responsive", async ({ page }) => {
    // Real-browser input-latency measurement (NIL-630 / NIL-551's
    // "measure before and after" precedent). This asserts only a generous
    // regression bound in CI -- the actual before/after numbers, produced by
    // swapping stickyFit.ts via a temporary file copy (never committed) and
    // rerunning this same measurement against the pre-NIL-630 behavior, are in
    // this package's HANDOFF, alongside the honest caveat this shared host's
    // own load dominated the variance between runs: the deterministic
    // real-layout-call-count comparison (stickyFit.ts's own header) is the
    // more trustworthy signal, and it found parity, not a regression, for
    // this note's actual (always-20pt) ceiling.
    await openEditor(page, drawingId);
    await placeNote(page, { x: 400, y: 300 });
    await expect(page.locator("textarea.excalidraw-wysiwyg")).toBeVisible();

    // Pre-fill so every subsequent keystroke re-normalises a note that is
    // already shrinking -- the expensive case, not the empty-note case.
    const prefix = "Filling this note with enough text that every further keystroke ".repeat(4);
    await page.keyboard.type(prefix, { delay: 0 });

    const sampleChars = "abcdefghijklmnopqrstuvwxyz".split("");
    const perCharMs: number[] = [];
    for (const ch of sampleChars) {
      const t0 = performance.now();
      await page.keyboard.type(ch, { delay: 0 });
      perCharMs.push(performance.now() - t0);
    }
    await page.keyboard.press("Escape");

    const total = perCharMs.reduce((a, b) => a + b, 0);
    const avg = total / perCharMs.length;
    const max = Math.max(...perCharMs);
    console.log(
      `NIL630_TYPING_LATENCY=${JSON.stringify({ totalMs: total, avgMs: avg, maxMs: max, samples: perCharMs.length })}`,
    );

    // Generous regression bound (this includes Playwright's own Node<->browser
    // IPC round trip per keystroke, not just render time) -- the number that
    // matters is the before/after comparison in the HANDOFF, not this bound.
    expect(avg).toBeLessThan(500);
  });
});
