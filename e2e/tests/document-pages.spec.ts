import { test, expect, type Page } from "@playwright/test";
import { createDrawing, deleteDrawing } from "./helpers/api";

/**
 * Paging through a document in a meeting is only useful if it happens for the
 * room. A test that watched the person clicking would pass on a widget that
 * quietly kept its page to itself, which is exactly the bug worth catching.
 */

// Long enough to be split into pages in the browser, and unmistakable per page.
const MARKDOWN = Array.from(
  { length: 60 },
  (_, i) => `## Section ${i + 1}\n\n${`Body text for section ${i + 1}. `.repeat(30)}\n`,
).join("\n");

const openEditor = async (page: Page, drawingId: string) => {
  await page.goto(`/editor/${drawingId}`);
  await page.waitForSelector(".excalidraw", { timeout: 30000 });
  await page.waitForTimeout(2000);
};

const dropMarkdown = async (page: Page, source: string, name = "notes.md") => {
  await page.evaluate(
    async ({ text, fileName }) => {
      const container = document.querySelector<HTMLElement>(".excalidraw")?.closest("div[style]");
      const target = container ?? document.body;
      const file = new File([text], fileName, { type: "text/markdown" });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const rect = target.getBoundingClientRect();
      target.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        }),
      );
    },
    { text: source, fileName: name },
  );
};

const pageLabel = (page: Page) => page.locator(".text-document-widget__page-number");

/**
 * Excalidraw keeps an embedded element behind its own canvas until you click
 * it, the same way it guards an embedded video. Until then the canvas swallows
 * every click, so the widget's own controls cannot be reached.
 */
const activateWidget = async (page: Page) => {
  const box = await page.locator(".text-document-widget").boundingBox();
  if (!box) throw new Error("The document widget is not on the board.");
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(300);
};

test("everyone in the room turns to the same page", async ({ browser, request }) => {
  const drawing = await createDrawing(request, { name: "Shared pages E2E" });

  const host = await browser.newContext();
  const hostPage = await host.newPage();
  await openEditor(hostPage, drawing.id);

  await dropMarkdown(hostPage, MARKDOWN);
  await expect(pageLabel(hostPage)).toContainText("Page 1 of", { timeout: 30000 });
  // Let the board carrying the new widget reach the server before anyone joins.
  await hostPage.waitForTimeout(3000);

  const guest = await browser.newContext();
  const guestPage = await guest.newPage();
  await openEditor(guestPage, drawing.id);
  await expect(pageLabel(guestPage)).toContainText("Page 1 of", { timeout: 30000 });

  await activateWidget(hostPage);
  await hostPage.getByRole("button", { name: "Next page" }).click();

  await expect(pageLabel(hostPage)).toContainText("Page 2 of", { timeout: 10000 });
  await expect(pageLabel(guestPage)).toContainText("Page 2 of", { timeout: 10000 });

  // Nobody is the presenter: whoever may edit the board may turn the page, and
  // the turn travels back the other way just as well.
  await activateWidget(guestPage);
  await guestPage.getByRole("button", { name: "Next page" }).click();
  await expect(pageLabel(guestPage)).toContainText("Page 3 of", { timeout: 10000 });
  await expect(pageLabel(hostPage)).toContainText("Page 3 of", { timeout: 10000 });

  // And the page the room is on outlives the tab that turned it: someone
  // arriving later is shown page 3, not page 1.
  const latecomer = await browser.newContext();
  const latecomerPage = await latecomer.newPage();
  await openEditor(latecomerPage, drawing.id);
  await expect(pageLabel(latecomerPage)).toContainText("Page 3 of", { timeout: 30000 });

  await host.close();
  await guest.close();
  await latecomer.close();
  await deleteDrawing(request, drawing.id);
});

const MAX_TEXT_UPLOAD_BYTES = 2 * 1024 * 1024;
const sparseLineBlock = `${"\n".repeat(19_999)}x`;
const PATHOLOGICAL_MARKDOWN = sparseLineBlock
  .repeat(Math.ceil(MAX_TEXT_UPLOAD_BYTES / sparseLineBlock.length))
  .slice(0, MAX_TEXT_UPLOAD_BYTES);

const startResponsivenessProbe = (page: Page) =>
  page.evaluate(() => {
    const state = { gaps: [] as number[], last: performance.now(), interval: 0 };
    state.interval = window.setInterval(() => {
      const now = performance.now();
      state.gaps.push(now - state.last);
      state.last = now;
    }, 10);
    (window as typeof window & { __nil269Probe?: typeof state }).__nil269Probe = state;
  });

const finishResponsivenessProbe = (page: Page) =>
  page.evaluate(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    const state = (
      window as typeof window & {
        __nil269Probe?: { gaps: number[]; last: number; interval: number };
      }
    ).__nil269Probe;
    if (!state) throw new Error("Responsiveness probe was not started.");
    window.clearInterval(state.interval);
    const ordered = [...state.gaps].sort((left, right) => left - right);
    return {
      samples: ordered.length,
      medianGapMs: ordered[Math.floor(ordered.length / 2)] ?? 0,
      p95GapMs: ordered[Math.floor(ordered.length * 0.95)] ?? 0,
      maxGapMs: ordered.at(-1) ?? 0,
    };
  });

test("a collaborator stays responsive while a pathological 2 MiB document is paginated", async ({
  browser,
  request,
}) => {
  const drawing = await createDrawing(request, { name: "Responsive document pagination E2E" });
  const host = await browser.newContext();
  const guest = await browser.newContext();
  const hostPage = await host.newPage();
  const guestPage = await guest.newPage();

  try {
    await Promise.all([openEditor(hostPage, drawing.id), openEditor(guestPage, drawing.id)]);

    await startResponsivenessProbe(guestPage);
    await dropMarkdown(hostPage, PATHOLOGICAL_MARKDOWN, "pathological-newlines.md");
    await expect(pageLabel(guestPage)).toHaveCount(1, { timeout: 30_000 });
    await expect(pageLabel(guestPage)).toContainText("Page 1 of", { timeout: 30_000 });
    const measurement = await finishResponsivenessProbe(guestPage);

    console.log(`NIL-269 responsiveness: ${JSON.stringify(measurement)}`);
    expect(PATHOLOGICAL_MARKDOWN).toHaveLength(MAX_TEXT_UPLOAD_BYTES);
    expect(measurement.samples).toBeGreaterThan(0);
    expect(measurement.p95GapMs).toBeLessThan(50);
    expect(measurement.maxGapMs).toBeLessThan(500);
  } finally {
    await host.close();
    await guest.close();
    await deleteDrawing(request, drawing.id);
  }
});
