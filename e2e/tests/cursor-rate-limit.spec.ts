import { expect, test, type Page } from "@playwright/test";
import { createDrawing, deleteDrawing } from "./helpers/api";
import { openEditor } from "./helpers/editor";

/**
 * A fixed, synchronous Socket.IO burst is independent of browser pointer
 * scheduling. Twelve connections each send their per-connection allowance of
 * 40 events: 480 total against the shared 160-event account budget. The
 * threefold margin still crosses the shared budget if transport delivery is
 * delayed across more than one rate-limit window.
 */
const CURSOR_PRESSURE_PAGE_COUNT = 12;
const CURSOR_EVENTS_PER_PAGE = 40;

const dropTinyPng = (page: Page) =>
  page.evaluate(() => {
    const bytes = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nC8AAAAASUVORK5CYII=",
      ),
      (character) => character.charCodeAt(0),
    );
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "cursor-pressure.png", { type: "image/png" }));
    const target = document.querySelector<HTMLElement>(".excalidraw") ?? document.body;
    const bounds = target.getBoundingClientRect();
    target.dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
        clientX: bounds.left + bounds.width / 2,
        clientY: bounds.top + bounds.height / 2,
      }),
    );
  });

test("image upload stays quiet when the shared cursor budget protects the server", async ({
  context,
  page,
  request,
}, testInfo) => {
  const drawing = await createDrawing(request, {
    name: `Cursor_Rate_Limit_${Date.now()}`,
    elements: [],
  });
  const pages = [page];

  try {
    for (let index = 1; index < CURSOR_PRESSURE_PAGE_COUNT; index += 1)
      pages.push(await context.newPage());

    // Join in sequence. The pressure below needs live cursor senders, but
    // joining all of their document pages at once contends for SQLite snapshot
    // and visit transactions before the rate-limit assertion even starts.
    for (const candidate of pages) {
      await openEditor(candidate, drawing.id);
      await candidate.waitForFunction(
        () => (window as any).__EXCALIDASH_SOCKET_STATUS__?.roomJoined === true,
      );
    }

    await dropTinyPng(page);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as any).__EXCALIDASH_TEST__
              .getSceneElements()
              .filter((element: any) => element.type === "image").length,
        ),
      )
      .toBe(1);

    await Promise.all(
      pages.map((candidate) =>
        candidate.evaluate(() => {
          const seen: string[] = [];
          (window as any).__NIL566_CURSOR_TOASTS__ = seen;
          const recordCursorToasts = () => {
            for (const toast of document.querySelectorAll<HTMLElement>("[data-sonner-toast]")) {
              const text = toast.innerText;
              if (/cursor-move rate limit exceeded/i.test(text) && !seen.includes(text)) {
                seen.push(text);
              }
            }
          };
          new MutationObserver(recordCursorToasts).observe(document.body, {
            childList: true,
            subtree: true,
          });
          recordCursorToasts();
        }),
      ),
    );

    const bursts = await Promise.all(
      pages.map((candidate, pageIndex) =>
        candidate.evaluate(
          ({ drawingId, pageIndex, count }) => {
            const status = (window as any).__EXCALIDASH_SOCKET_STATUS__;
            if (typeof status?.emitTestEvent !== "function")
              throw new Error("Cursor pressure Socket.IO test seam is unavailable");
            const pressure = { sent: 0, rejections: 0 };
            (window as any).__NIL697_CURSOR_PRESSURE__ = pressure;
            const startedAt = performance.now();
            for (let index = 0; index < count; index += 1) {
              status.emitTestEvent(
                "cursor-move",
                {
                  drawingId,
                  pointer: { x: pageIndex * 100 + index, y: index, tool: "pointer" },
                  button: "up",
                },
                (reply: any) => {
                  if (reply?.error?.code === "rate-limited") pressure.rejections += 1;
                },
              );
              pressure.sent += 1;
            }
            return { sent: pressure.sent, emittedMs: performance.now() - startedAt };
          },
          { drawingId: drawing.id, pageIndex, count: CURSOR_EVENTS_PER_PAGE },
        ),
      ),
    );
    const sent = bursts.reduce((total, burst) => total + burst.sent, 0);
    expect(sent).toBe(CURSOR_PRESSURE_PAGE_COUNT * CURSOR_EVENTS_PER_PAGE);

    let rejections = 0;
    await expect
      .poll(async () => {
        rejections = (
          await Promise.all(
            pages.map((candidate) =>
              candidate.evaluate(() => (window as any).__NIL697_CURSOR_PRESSURE__?.rejections ?? 0),
            ),
          )
        ).reduce((total, count) => total + count, 0);
        return rejections;
      })
      .toBeGreaterThan(0);
    const slowestBurstMs = Math.max(...bursts.map((burst) => burst.emittedMs));
    console.log(
      `[NIL-697] queued ${sent} cursor events across ${CURSOR_PRESSURE_PAGE_COUNT} sockets; ` +
        `${rejections} shared-budget rejections; slowest enqueue ${slowestBurstMs.toFixed(1)}ms`,
    );
    const cursorToasts = (
      await Promise.all(
        pages.map((candidate) =>
          candidate.evaluate(() => (window as any).__NIL566_CURSOR_TOASTS__ as string[]),
        ),
      )
    ).flat();
    expect(cursorToasts).toEqual([]);
    await testInfo.attach("cursor-rate-limit-quiet-upload", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  } finally {
    await Promise.all(pages.slice(1).map((candidate) => candidate.close()));
    await deleteDrawing(request, drawing.id);
  }
});
