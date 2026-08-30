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
const CURSOR_PRESSURE_PAGE_COUNT = 12;
const CURSOR_PRESSURE_TRIALS = 3;
const CURSOR_PRESSURE_TRIALS_REQUIRED = 2;
const CURSOR_RATE_LIMIT_WINDOW_MS = 1_000;

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

type CursorPressureTrial = {
  emitted: number;
  rejected: boolean;
  rejections: number;
};

const runCursorPressureTrial = async ({
  pages,
  canvasBounds,
  cursorEmissions,
  cursorRejections,
}: {
  pages: Page[];
  canvasBounds: Awaited<ReturnType<Page["locator"]>["boundingBox"]>[];
  cursorEmissions: string[];
  cursorRejections: string[];
}): Promise<CursorPressureTrial> => {
  const rejectionsBefore = cursorRejections.length;
  const emissionsBefore = cursorEmissions.length;

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

  let rejected = false;
  try {
    await expect
      .poll(() => cursorRejections.length, {
        message: "the shared cursor-move budget never rejected a single event",
        timeout: CURSOR_PRESSURE_MAX_MS,
      })
      .toBeGreaterThan(rejectionsBefore);
    rejected = true;
  } catch {
    // A loaded runner can miss one pressure attempt. The caller evaluates a
    // fixed 2-of-3 majority; transport/setup failures still escape below.
  } finally {
    await Promise.all(
      pages.map((candidate) =>
        candidate.evaluate(() => {
          (window as any).__NIL596_STOP_CURSOR_PRESSURE__ = true;
        }),
      ),
    );
    await sendersSettled;
  }

  return {
    emitted: cursorEmissions.length - emissionsBefore,
    rejected,
    rejections: cursorRejections.length - rejectionsBefore,
  };
};

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
    for (let index = 1; index < CURSOR_PRESSURE_PAGE_COUNT; index += 1)
      pages.push(await context.newPage());
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

    // Join in sequence. The pressure below needs 12 live cursor senders, but
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

    // NIL-596/NIL-697: each attempt sends until the shared budget actually
    // rejects something, never for a target duration. A fixed single attempt
    // still lets an overloaded runner decide the result: it can fail to emit
    // enough events in its safety window. Two successful attempts out of
    // three retain the throttle assertion while tolerating one host-jitter
    // outlier; a disabled throttle fails every attempt.
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

    const trials: CursorPressureTrial[] = [];
    for (let attempt = 0; attempt < CURSOR_PRESSURE_TRIALS; attempt += 1) {
      if (attempt > 0) await page.waitForTimeout(CURSOR_RATE_LIMIT_WINDOW_MS + 100);
      const trial = await runCursorPressureTrial({
        pages,
        canvasBounds,
        cursorEmissions,
        cursorRejections,
      });
      trials.push(trial);
      console.log(
        `NIL-697 cursor pressure trial ${attempt + 1}/${CURSOR_PRESSURE_TRIALS}: ${JSON.stringify(trial)}`,
      );
      if (
        trials.filter((candidate) => candidate.rejected).length >= CURSOR_PRESSURE_TRIALS_REQUIRED
      )
        break;
    }

    expect(
      trials.filter((trial) => trial.rejected).length,
      `need ${CURSOR_PRESSURE_TRIALS_REQUIRED} of ${CURSOR_PRESSURE_TRIALS} pressure trials to observe a shared-budget rejection: ${JSON.stringify(trials)}`,
    ).toBeGreaterThanOrEqual(CURSOR_PRESSURE_TRIALS_REQUIRED);
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
