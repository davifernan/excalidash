import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { createDrawing, deleteDrawing } from "./helpers/api";
import { armTool, labels, openEditor } from "./helpers/editor";

/**
 * NIL-580's own Nachweispflicht, against real browser font metrics rather
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

/** Sets a note's label text directly through the harness, bypassing typing --
 * the measurement series and cross-context checks care about the derived
 * size for a given piece of content, not about the typing path itself
 * (sticky-notes.spec.ts already covers typing). */
const setLabelText = async (page: Page, text: string) => {
  await page.evaluate((value) => {
    const api = (window as any).__EXCALIDASH_TEST__;
    const elements = api.getSceneElements();
    const withText = elements.map((element: any) =>
      element.type === "text" ? { ...element, text: value, originalText: value } : element,
    );
    api.updateScene({ elements: withText });
  }, text);
  await settle(page);
};

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

test.describe("sticky note font scaling (NIL-580)", () => {
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

  test("font size shrinks continuously with text length, not in the old fixed steps", async ({
    page,
  }) => {
    await openEditor(page, drawingId);
    await placeNote(page, { x: 400, y: 300 });
    await page.keyboard.type("x");
    await page.keyboard.press("Escape");
    await settle(page);

    const OLD_LADDER = [36, 28, 20, 16, 12, 10, 8];
    const wordCounts = [1, 5, 10, 15, 20, 25, 30, 40, 60];
    const series: Array<{ words: number; fontSize: number }> = [];

    for (const n of wordCounts) {
      await setLabelText(page, words(n));
      const [label] = await labels(page);
      series.push({ words: n, fontSize: label.fontSize });
    }

    // Printed as numbers, not asserted invisibly -- this is the required
    // measurement series (fontSize over text length), real font metrics.
    console.log(`NIL580_FONT_SERIES=${JSON.stringify(series)}`);

    // Monotonic: more content never yields a bigger font.
    for (let i = 1; i < series.length; i += 1) {
      expect(series[i].fontSize).toBeLessThanOrEqual(series[i - 1].fontSize);
    }
    // Strictly decreasing somewhere -- the note actually shrinks as content
    // grows, not just clamped flat at one end.
    expect(series[series.length - 1].fontSize).toBeLessThan(series[0].fontSize);

    // The point of this cut: at least one measured size must fall strictly
    // between two adjacent old rungs, proving the curve is no longer stepped.
    const betweenRungs = series.some(({ fontSize }) => {
      if (OLD_LADDER.includes(fontSize)) return false;
      return OLD_LADDER.some((rung, i) => i > 0 && fontSize < OLD_LADDER[i - 1] && fontSize > rung);
    });
    expect(betweenRungs).toBe(true);
  });

  test("two browser contexts derive the same font size for the same content", async ({
    browser,
  }) => {
    // One context, two tabs: a fresh `browser.newContext()` is a fresh
    // anonymous identity with no access to a drawing it did not create --
    // see image-collab.spec.ts's `openEditorTab` for the same pattern. Two
    // real, independent editor instances is the point (each computes its own
    // fontSize locally); two separate visitor identities is not.
    const context = await browser.newContext();
    try {
      const pageA = await context.newPage();
      const pageB = await context.newPage();

      await openEditor(pageA, drawingId);
      await openEditor(pageB, drawingId);

      await placeNote(pageA, { x: 400, y: 300 });
      await pageA.keyboard.type("x");
      await pageA.keyboard.press("Escape");
      await settle(pageA);

      const longText =
        "Two people looking at the same note from two different browsers must see " +
        "the writing at exactly the same size, because it is derived from the note's " +
        "content and dimensions alone, never stored and synced as a separate value.";
      await setLabelText(pageA, longText);

      // Wait for B to receive the synced text before reading its own derived
      // size -- B computes its own fontSize locally, it does not receive one.
      // Matched against `originalText`, not `text`: the fit pass on A already
      // rewrote `text` with the wrapped line breaks its own font size chose,
      // so the flat string never appears there again.
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

      expect(labelA.fontSize).toBeGreaterThan(0);
      expect(labelA.fontSize).toBe(labelB.fontSize);
    } finally {
      await context.close();
    }
  });

  test("typing into a long note stays responsive", async ({ page }) => {
    // Real-browser input-latency measurement (NIL-580 point 4 / NIL-551's
    // "measure before and after" precedent). This asserts only a generous
    // regression bound in CI -- the actual before/after numbers, produced by
    // swapping stickyFit.ts via a temporary file copy (never committed) and
    // rerunning this same measurement against the pre-NIL-580 ladder, are in
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
      `NIL580_TYPING_LATENCY=${JSON.stringify({ totalMs: total, avgMs: avg, maxMs: max, samples: perCharMs.length })}`,
    );

    // Generous regression bound (this includes Playwright's own Node<->browser
    // IPC round trip per keystroke, not just render time) -- the number that
    // matters is the before/after comparison in the HANDOFF, not this bound.
    expect(avg).toBeLessThan(500);
  });
});
