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

/**
 * Polls `read()` until it returns the same value for `stableReads` polls in a
 * row, instead of a single fixed sleep (NIL-690). A fixed sleep only proves
 * "nothing changed across exactly this one gap" -- a same-content echo that
 * lands a beat after the gap ends is invisible to it, which is exactly how
 * the late version/versionNonce/updated bump this guards against first
 * surfaced. Polling for confirmed stability catches a SINGLE late echo
 * followed by calm, because the final poll is compared against a baseline
 * captured before polling started, not merely "did it stabilize to
 * something" -- verified directly against a scripted read sequence, not
 * assumed (see this package's PR body). It does NOT catch a bookkeeping
 * round-trip that returns to the original value before the last poll
 * (`350 -> 351 -> 350`); a fixed sleep does not catch that either -- both
 * designs compare two point-in-time snapshots and share that blind spot.
 */
const waitForStable = async <T>(
  read: () => Promise<T>,
  options: { stableReads?: number; pollMs?: number; timeoutMs?: number } = {},
): Promise<T> => {
  const { stableReads = 5, pollMs = 200, timeoutMs = 8000 } = options;
  const deadline = Date.now() + timeoutMs;
  let lastValue = await read();
  let lastSerialized = JSON.stringify(lastValue);
  let stableCount = 1;
  while (stableCount < stableReads) {
    if (Date.now() > deadline) {
      throw new Error(
        `Value did not stay stable for ${stableReads} consecutive reads within ${timeoutMs}ms (last=${lastSerialized})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const value = await read();
    const serialized = JSON.stringify(value);
    if (serialized === lastSerialized) {
      stableCount += 1;
    } else {
      stableCount = 1;
      lastSerialized = serialized;
      lastValue = value;
    }
  }
  return lastValue;
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
          return element.type === "text" && !element.isDeleted
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
    page: pageA,
  }) => {
    const contextB = await browser.newContext();
    try {
      const longText =
        "Two people looking at the same note from two different browsers must see " +
        "the writing at exactly the same size, because it is derived from the note's " +
        "content and dimensions alone, never stored and synced as a separate value.";
      await openEditor(pageA, drawingId);
      await placeNote(pageA, { x: 400, y: 300 });
      await pageA.keyboard.type(longText, { delay: 0 });
      await pageA.keyboard.press("Escape");
      await settle(pageA);

      // Wait until the transport boundary contains the canonical reference
      // size and remembered 200x200 geometry. Only then let a second context
      // load that exact authoritative state. This isolates the contract under
      // test: both browsers derive from identical content/geometry, without a
      // live-typing delivery race deciding whether B has the prerequisite.
      await expect
        .poll(async () => {
          const drawing = await getDrawing(api, drawingId);
          const note = drawing.elements?.find((element: any) =>
            Boolean(element.customData?.excalidash?.sticky),
          );
          const label = drawing.elements?.find(
            (element: any) => element.type === "text" && !element.isDeleted,
          );
          return {
            originalText: label?.originalText,
            fontSize: label?.fontSize,
            noteWidth: note?.customData?.excalidash?.sticky?.width,
            noteHeight: note?.customData?.excalidash?.sticky?.height,
          };
        })
        .toEqual({
          originalText: longText,
          fontSize: 20,
          noteWidth: 200,
          noteHeight: 200,
        });

      const pageB = await contextB.newPage();
      await openEditor(pageB, drawingId);
      await pageB.waitForFunction(
        (expected) =>
          (window as any).__EXCALIDASH_TEST__
            ?.getSceneElements()
            .some((element: any) => element.originalText === expected) ?? false,
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
      // A single fixed sleep only proves nothing changed across exactly that
      // one gap; polling for confirmed stability catches a same-content echo
      // landing at any point after, not just inside one arbitrary window
      // (NIL-690) -- and each side is checked against its OWN prior reading,
      // so a drift is caught even if both sides drifted to the same value.
      expect(await waitForStable(() => revisions(pageA))).toEqual(settledA);
      expect(await waitForStable(() => revisions(pageB))).toEqual(settledB);
    } finally {
      await contextB.close();
    }
  });

  test("a spectator keeps its sticky geometry while a collaborator types a space", async ({
    browser,
    page: writer,
  }) => {
    const spectatorContext = await browser.newContext();
    try {
      const spectator = await spectatorContext.newPage();
      await Promise.all([openEditor(writer, drawingId), openEditor(spectator, drawingId)]);
      await expect(writer.locator(".UserList__collaborator .Avatar")).toHaveCount(1);
      await expect(spectator.locator(".UserList__collaborator .Avatar")).toHaveCount(1);

      await placeNote(writer, { x: 400, y: 300 });
      await writer.keyboard.type(textAt(100), { delay: 0 });
      await writer.keyboard.press("Escape");
      await settle(writer);

      await expect
        .poll(async () => (await labels(spectator))[0]?.originalText ?? null, { timeout: 15_000 })
        .toBe(textAt(100));

      const snapshot = () =>
        spectator.evaluate(() => {
          const elements = (window as any).__EXCALIDASH_TEST__.getSceneElements();
          const note = elements.find((element: any) => element.customData?.excalidash?.sticky);
          const label = elements.find((element: any) => element.containerId === note?.id);
          return [note?.x, note?.y, note?.width, note?.height, label?.fontSize] as const;
        });
      // NIL-689: the note's own `boundElements` reference to its label, as the
      // spectator sees it -- not just the label's `containerId` used above.
      // `deriveStickyFontState` reads the note side of that link
      // (`note.boundElements?.find(el => el.type === "text")`); a spectator
      // that never sees the note's own boundElements update never fits the
      // font locally, regardless of whether the label content itself arrived.
      const noteBoundLabelId = () =>
        spectator.evaluate(() => {
          const elements = (window as any).__EXCALIDASH_TEST__.getSceneElements();
          const note = elements.find((element: any) => element.customData?.excalidash?.sticky);
          return note?.boundElements?.find((bound: any) => bound?.type === "text")?.id ?? null;
        });

      await writer
        .locator("canvas")
        .last()
        .dblclick({ position: { x: 400, y: 300 } });
      await expect(writer.locator("textarea.excalidraw-wysiwyg")).toBeVisible();
      const before = await snapshot();
      await writer.keyboard.press("End");
      await writer.keyboard.press("Space");
      const expectedText = `${textAt(100)} `;
      await expect
        .poll(
          () =>
            spectator.evaluate(() => {
              const elements = (window as any).__EXCALIDASH_TEST__.getSceneElements();
              return elements.find((element: any) => element.containerId)?.originalText ?? null;
            }),
          { timeout: 15_000 },
        )
        .toBe(expectedText);
      const samples = await spectator.evaluate(
        (initial) =>
          new Promise<Array<readonly (number | undefined)[]>>((resolve) => {
            const frames: Array<readonly (number | undefined)[]> = [initial];
            const until = performance.now() + 1_000;
            const sample = () => {
              const elements = (window as any).__EXCALIDASH_TEST__.getSceneElements();
              const note = elements.find((element: any) => element.customData?.excalidash?.sticky);
              const label = elements.find((element: any) => element.containerId === note?.id);
              frames.push([note?.x, note?.y, note?.width, note?.height, label?.fontSize]);
              if (performance.now() < until) requestAnimationFrame(sample);
              else resolve(frames);
            };
            requestAnimationFrame(sample);
          }),
        before,
      );
      const after = await snapshot();
      // NIL-689 regression: the spectator's own note element must carry a
      // `boundElements` reference to the label it is currently displaying --
      // not just the label existing with the right text via `containerId`.
      const spectatorLabelId = await spectator.evaluate(() => {
        const elements = (window as any).__EXCALIDASH_TEST__.getSceneElements();
        const note = elements.find((element: any) => element.customData?.excalidash?.sticky);
        return elements.find((element: any) => element.containerId === note?.id)?.id ?? null;
      });
      expect(spectatorLabelId).not.toBeNull();
      expect(await noteBoundLabelId()).toBe(spectatorLabelId);
      const states = samples.filter(
        (sample, index) =>
          index === 0 || sample.some((value, field) => value !== samples[index - 1][field]),
      );

      const allowedGeometries = new Set([
        JSON.stringify(before.slice(0, 4)),
        JSON.stringify(after.slice(0, 4)),
      ]);
      const unexpectedGeometry = states.find(
        (state) => !allowedGeometries.has(JSON.stringify(state.slice(0, 4))),
      );
      console.log(
        `NIL645_SPECTATOR_SPACE=${JSON.stringify({ before, states, after, unexpectedGeometry })}`,
      );
      // Start only after the peer received the Space, then watch every frame
      // for a second. The Font projection can arrive in a separate harmless
      // frame, but no sampled note geometry may be other than the starting
      // or settled geometry; that would be the visible text-edit box flicker.
      expect(unexpectedGeometry).toBeUndefined();
    } finally {
      await spectatorContext.close();
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
