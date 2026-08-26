import { expect, test, type Page } from "@playwright/test";
import { createDrawing, deleteDrawing } from "./helpers/api";
import { openEditor } from "./helpers/editor";

type EdgeName = "top" | "right" | "bottom" | "left";

const installConnectionProbe = (page: Page) =>
  page.addInitScript(() => {
    type Probe = {
      statuses: string[];
      expectedEdge: string;
      targets: Record<string, Element>;
      clicks: Array<{ edge: string; delivered: boolean }>;
    };
    const probe: Probe = { statuses: [], expectedEdge: "", targets: {}, clicks: [] };
    (window as unknown as { __NIL605_CONNECTION_PROBE__: Probe }).__NIL605_CONNECTION_PROBE__ =
      probe;

    const start = () => {
      const recordStatus = () => {
        const frame = document.querySelector<HTMLElement>(
          "[data-testid='connection-status-frame']",
        );
        const next = frame?.dataset.status ?? "connected";
        if (probe.statuses.at(-1) !== next) probe.statuses.push(next);
      };
      new MutationObserver(recordStatus).observe(document.documentElement, {
        attributes: true,
        childList: true,
        subtree: true,
      });
      document.addEventListener(
        "click",
        (event) => {
          if (!probe.expectedEdge) return;
          probe.clicks.push({
            edge: probe.expectedEdge,
            delivered: event.target === probe.targets[probe.expectedEdge],
          });
        },
        true,
      );
      recordStatus();
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }
  });

const connectionStatuses = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          __NIL605_CONNECTION_PROBE__: { statuses: string[] };
        }
      ).__NIL605_CONNECTION_PROBE__.statuses,
  );

test("connection failures frame the viewport without intercepting any edge", async ({
  browser,
  request,
}, testInfo) => {
  test.setTimeout(90_000);
  const drawing = await createDrawing(request, { name: `Connection frame ${Date.now()}` });
  const firstContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const secondContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const first = await firstContext.newPage();
  const second = await secondContext.newPage();

  try {
    await Promise.all([installConnectionProbe(first), installConnectionProbe(second)]);
    await Promise.all([
      openEditor(first, drawing.id, { settleMs: 2_000 }),
      openEditor(second, drawing.id, { settleMs: 2_000 }),
    ]);

    const frame = (page: Page) => page.getByTestId("connection-status-frame");
    const badge = (page: Page) => page.getByTestId("connection-status-badge");

    // Healthy means absent, not hidden: there is no full-screen connection
    // element in the DOM that could unexpectedly win hit-testing.
    await expect(frame(first)).toHaveCount(0);
    await expect(badge(first)).toHaveCount(0);
    await expect(frame(second)).toHaveCount(0);
    await expect(badge(second)).toHaveCount(0);
    await testInfo.attach("connected-no-connection-chrome", {
      body: await first.screenshot(),
      contentType: "image/png",
    });

    const edgePoints: Array<{ name: EdgeName; x: number; y: number }> = [
      { name: "top", x: 640, y: 1 },
      { name: "right", x: 1278, y: 360 },
      { name: "bottom", x: 640, y: 718 },
      { name: "left", x: 1, y: 360 },
    ];
    const underlying = await first.evaluate((points) => {
      const probe = (
        window as unknown as {
          __NIL605_CONNECTION_PROBE__: { targets: Record<string, Element> };
        }
      ).__NIL605_CONNECTION_PROBE__;
      return points.map(({ name, x, y }) => {
        const target = document.elementFromPoint(x, y);
        if (!target) throw new Error(`No underlying target at ${name} edge`);
        probe.targets[name] = target;
        return { name, tag: target.tagName, className: target.getAttribute("class") ?? "" };
      });
    }, edgePoints);

    await Promise.all([firstContext.setOffline(true), secondContext.setOffline(true)]);
    await expect(frame(first)).toHaveAttribute("data-status", "offline");
    await expect(badge(first)).toHaveText("Disconnected");
    await expect(frame(second)).toHaveAttribute("data-status", "offline");
    await expect(badge(second)).toHaveText("Disconnected");
    await Promise.all(
      [first, second].map((page) =>
        page.evaluate(() => {
          (
            window as unknown as {
              __EXCALIDASH_SOCKET_STATUS__?: { dropTransport: () => void };
            }
          ).__EXCALIDASH_SOCKET_STATUS__?.dropTransport();
        }),
      ),
    );
    await Promise.all(
      [first, second].map((page) =>
        expect
          .poll(
            () =>
              page.evaluate(
                () =>
                  (window as unknown as { __EXCALIDASH_SOCKET_STATUS__?: { connected: boolean } })
                    .__EXCALIDASH_SOCKET_STATUS__?.connected,
              ),
            { timeout: 15_000 },
          )
          .toBe(false),
      ),
    );

    const geometry = await frame(first).evaluate((element) => {
      const style = getComputedStyle(element);
      const badgeElement = element.querySelector<HTMLElement>(".connection-status-frame__badge");
      const badgeStyle = badgeElement ? getComputedStyle(badgeElement) : null;
      const rect = element.getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        borderWidths: [
          style.borderTopWidth,
          style.borderRightWidth,
          style.borderBottomWidth,
          style.borderLeftWidth,
        ],
        borderColor: style.borderTopColor,
        pointerEvents: style.pointerEvents,
        badgePointerEvents: badgeStyle?.pointerEvents,
        badgeShape: badgeStyle?.borderRadius,
      };
    });
    expect(geometry).toMatchObject({
      x: 0,
      y: 0,
      width: 1280,
      height: 720,
      borderWidths: ["1px", "1px", "1px", "1px"],
      borderColor: "rgb(220, 38, 38)",
      pointerEvents: "none",
      badgePointerEvents: "none",
    });

    for (const point of edgePoints) {
      await first.evaluate((name) => {
        (
          window as unknown as {
            __NIL605_CONNECTION_PROBE__: { expectedEdge: string };
          }
        ).__NIL605_CONNECTION_PROBE__.expectedEdge = name;
      }, point.name);
      await first.mouse.click(point.x, point.y);
    }
    const clicks = await first.evaluate(
      () =>
        (
          window as unknown as {
            __NIL605_CONNECTION_PROBE__: {
              clicks: Array<{ edge: string; delivered: boolean }>;
            };
          }
        ).__NIL605_CONNECTION_PROBE__.clicks,
    );
    expect(clicks).toEqual(edgePoints.map(({ name }) => ({ edge: name, delivered: true })));

    await testInfo.attach("disconnected-frame", {
      body: await first.screenshot(),
      contentType: "image/png",
    });

    // Hold both transports offline but deliver the browser's online signal so
    // the genuine UI state remains reconnecting long enough to verify the
    // visible dot sequence. Re-enabling transport below completes the real
    // socket rejoin and removes the failure UI again.
    await Promise.all([
      first.evaluate(() => window.dispatchEvent(new Event("online"))),
      second.evaluate(() => window.dispatchEvent(new Event("online"))),
    ]);
    await expect(frame(first)).toHaveAttribute("data-status", "reconnecting");
    await expect(frame(second)).toHaveAttribute("data-status", "reconnecting");
    const dotSamples: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      dotSamples.push(await first.getByTestId("connection-status-dots").innerText());
      await first.waitForTimeout(475);
    }
    expect(new Set(dotSamples)).toEqual(new Set([".", "..", "..."]));
    await testInfo.attach("reconnecting-frame", {
      body: await first.screenshot(),
      contentType: "image/png",
    });

    await Promise.all([firstContext.setOffline(false), secondContext.setOffline(false)]);
    await expect(frame(first)).toHaveCount(0, { timeout: 15_000 });
    await expect(frame(second)).toHaveCount(0, { timeout: 15_000 });

    const [firstStatuses, secondStatuses] = await Promise.all([
      connectionStatuses(first),
      connectionStatuses(second),
    ]);
    expect(firstStatuses).toEqual(expect.arrayContaining(["connected", "offline", "reconnecting"]));
    expect(secondStatuses).toEqual(
      expect.arrayContaining(["connected", "offline", "reconnecting"]),
    );
    expect(firstStatuses.at(-1)).toBe("connected");
    expect(secondStatuses.at(-1)).toBe("connected");

    console.log(
      "[connection-frame-evidence]",
      JSON.stringify({ geometry, underlying, clicks, dotSamples, firstStatuses, secondStatuses }),
    );
  } finally {
    await Promise.all([firstContext.close(), secondContext.close()]);
    await deleteDrawing(request, drawing.id).catch(() => {});
  }
});
