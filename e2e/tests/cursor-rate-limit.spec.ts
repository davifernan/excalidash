import { expect, test, type Page } from "@playwright/test";
import { createDrawing, deleteDrawing } from "./helpers/api";
import { openEditor } from "./helpers/editor";

const interactiveCanvas = (page: Page) => page.locator("canvas.excalidraw__canvas.interactive");

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

    await Promise.all(
      pages.map(async (candidate, pageIndex) => {
        const bounds = await interactiveCanvas(candidate).boundingBox();
        if (!bounds) throw new Error("Interactive canvas not found");
        await candidate.evaluate(
          ({ pageIndex, bounds }) =>
            new Promise<void>((resolve) => {
              const canvas = document.querySelector<HTMLCanvasElement>(
                "canvas.excalidraw__canvas.interactive",
              );
              if (!canvas) throw new Error("Interactive canvas not found");
              let movement = 0;
              const interval = window.setInterval(() => {
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
              }, 2_000);
            }),
          { pageIndex, bounds },
        );
      }),
    );

    expect(cursorEmissions.length).toBeGreaterThan(160);
    await expect.poll(() => cursorRejections.length).toBeGreaterThan(0);
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
