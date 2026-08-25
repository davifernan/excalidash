import { expect, test, type Page } from "@playwright/test";
import { createDrawing, deleteDrawing } from "./helpers/api";
import { openEditor } from "./helpers/editor";

const interactiveCanvas = (page: Page) => page.locator("canvas.excalidraw__canvas.interactive");

/**
 * Safety cap for the cursor-pressure senders (NIL-596), not a target
 * duration. The server's shared cursor-move budget is 160 events/second
 * per account (`createKeyedRateLimiter(40 * 4, 1_000)`,
 * `backend/src/server/socket.ts`); 12 pages each dispatching every 3ms
 * attempt roughly 4000 events/s combined, ~25x over budget, so a working
 * throttle rejects within well under a second. This bound only matters if
 * the throttle is broken -- generous enough that a healthy CI host is never
 * the reason it fires, tight enough that a genuinely broken throttle still
 * fails in reasonable time instead of hanging.
 */
const CURSOR_PRESSURE_MAX_MS = 8_000;

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
}) => {
  const drawing = await createDrawing(request, {
    name: `Cursor_Rate_Limit_${Date.now()}`,
    elements: [],
  });
  const pages = [page];
  const cursorRejections: string[] = [];
  const cursorEmissions: string[] = [];

  try {
    for (let index = 1; index < 12; index += 1) pages.push(await context.newPage());
    for (const candidate of pages) {
      candidate.on("websocket", (socket) => {
        socket.on("framesent", ({ payload }) => {
          if (typeof payload === "string" && payload.includes('"cursor-move"')) {
            cursorEmissions.push(payload);
          }
        });
        socket.on("framereceived", ({ payload }) => {
          if (
            typeof payload === "string" &&
            payload.includes('"room-event-error"') &&
            payload.includes('"event":"cursor-move"') &&
            payload.includes('"code":"rate-limited"')
          ) {
            cursorRejections.push(payload);
          }
        });
      });
    }

    await Promise.all(
      pages.map(async (candidate) => {
        await openEditor(candidate, drawing.id);
        await candidate.waitForFunction(
          () => (window as any).__EXCALIDASH_SOCKET_STATUS__?.roomJoined === true,
        );
      }),
    );

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

    // NIL-596: sends until the shared budget actually rejects something,
    // not for a fixed wall-clock duration. A fixed 2s window measures
    // whether this runner was fast enough to overrun the throttle in that
    // time -- a throughput fact about the host, not a behavior fact about
    // the throttle. CURSOR_PRESSURE_MAX_MS is a safety cap, not a target:
    // 12 pages dispatching every 3ms attempt roughly 4000 events/s against
    // a 160-events/s shared budget, so a working throttle rejects within a
    // small fraction of a second -- the cap only matters if the throttle is
    // genuinely broken, and stopping as soon as it fires keeps the common
    // case at least as fast as the old fixed wait, not slower.
    // Resolve every page's canvas bounds up front, awaited immediately --
    // not lazily inside `sendersSettled`, which is only awaited after the
    // rejection poll below. A missing canvas otherwise stayed hidden behind
    // the full poll timeout and surfaced the poll's own misleading message
    // instead of this real, immediate cause (PR #176 review, Low).
    const canvasBounds = await Promise.all(
      pages.map(async (candidate) => {
        const bounds = await interactiveCanvas(candidate).boundingBox();
        if (!bounds) throw new Error("Interactive canvas not found");
        return bounds;
      }),
    );

    // Reset every page's stop flag up front too, in one batch fully awaited
    // before any page starts dispatching. Resetting it per-page instead,
    // inside the same async chain that starts each page's own interval,
    // raced the global stop command below: a page whose own setup was still
    // in flight when another page's rejection triggered the global stop
    // would have this reset overwrite that page's already-set `true` back
    // to `false`, leaving it running for the full `CURSOR_PRESSURE_MAX_MS`
    // cap (PR #176 review, Medium -- a fix for a timing-dependent test that
    // introduced its own race, which is exactly what NIL-596 set out to
    // remove). Doing the reset here, before any interval exists to race
    // against, removes the race instead of narrowing its window.
    await Promise.all(
      pages.map((candidate) =>
        candidate.evaluate(() => {
          (window as any).__NIL596_STOP_CURSOR_PRESSURE__ = false;
        }),
      ),
    );

    const sendersSettled = Promise.all(
      pages.map((candidate, pageIndex) =>
        candidate.evaluate(
          ({ pageIndex, bounds, maxMs }) =>
            new Promise<void>((resolve) => {
              const canvas = document.querySelector<HTMLCanvasElement>(
                "canvas.excalidraw__canvas.interactive",
              );
              if (!canvas) throw new Error("Interactive canvas not found");
              let movement = 0;
              const interval = window.setInterval(() => {
                if ((window as any).__NIL596_STOP_CURSOR_PRESSURE__) {
                  window.clearInterval(interval);
                  resolve();
                  return;
                }
                canvas.dispatchEvent(
                  new PointerEvent("pointermove", {
                    bubbles: true,
                    buttons: 1,
                    clientX:
                      bounds.x +
                      80 +
                      ((movement * 17 + pageIndex * 13) % Math.max(100, bounds.width - 160)),
                    clientY:
                      bounds.y +
                      100 +
                      ((movement * 11 + pageIndex * 7) % Math.max(100, bounds.height - 180)),
                    pointerId: 1,
                    pointerType: "mouse",
                  }),
                );
                movement += 1;
              }, 3);
              window.setTimeout(() => {
                window.clearInterval(interval);
                resolve();
              }, maxMs);
            }),
          { pageIndex, bounds: canvasBounds[pageIndex], maxMs: CURSOR_PRESSURE_MAX_MS },
        ),
      ),
    );

    await expect
      .poll(() => cursorRejections.length, {
        message: "the shared cursor-move budget never rejected a single event",
        timeout: CURSOR_PRESSURE_MAX_MS,
      })
      .toBeGreaterThan(0);

    // Stop every page's dispatch loop the moment the throttle actually
    // fired, rather than letting them run out their own safety cap.
    await Promise.all(
      pages.map((candidate) =>
        candidate.evaluate(() => {
          (window as any).__NIL596_STOP_CURSOR_PRESSURE__ = true;
        }),
      ),
    );
    await sendersSettled;

    expect(cursorEmissions.length).toBeGreaterThan(160);
    const cursorToasts = (
      await Promise.all(
        pages.map((candidate) =>
          candidate.evaluate(() => (window as any).__NIL566_CURSOR_TOASTS__ as string[]),
        ),
      )
    ).flat();
    expect(cursorToasts).toEqual([]);
  } finally {
    await Promise.all(pages.slice(1).map((candidate) => candidate.close()));
    await deleteDrawing(request, drawing.id);
  }
});
