import { expect, test, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import { createDrawing, deleteDrawing, getDrawing, updateDrawing } from "./helpers/api";
import {
  activateDocumentWidget,
  documentPageLabel,
  dropMarkdown,
  injectNoiseImage,
  openEditor as openEditorReady,
  waitForPeerFile,
} from "./helpers/editor";

/**
 * NIL-330 -- M0's integrated guardrail and collaboration acceptance test.
 *
 * Every guardrail this test drives (file-size rejection, split delivery,
 * reconnect reset, page-turn sequencing, invalid-widget refusal) already has
 * its own green test somewhere else in this suite or in the backend unit
 * suite. That is not what this file is for. NIL-330 exists because this
 * roadmap has already seen guardrails that were each fine alone collide: two
 * packages independently set a third header icon and Excalidraw's own
 * avatar list collapsed, and neither package's own tests ever ran the two
 * changes at once. This test runs the guardrails together, on one board,
 * under the same combined pressure a real working session puts on them --
 * concurrent writers, a mid-transfer drop, a widget that stops existing
 * while somebody is still looking at it.
 *
 * It is deliberately one long test rather than several short ones: splitting
 * it would let each piece pass in isolation again, which is exactly the
 * blind spot it exists to close. `test.step` sections keep the report
 * readable without losing the shared board/session state between them.
 */

const openEditor = (page: Page, drawingId: string) => openEditorReady(page, drawingId);

const socketConnected = (page: Page) =>
  page.evaluate(() => (window as any).__EXCALIDASH_SOCKET_STATUS__?.connected === true);

const waitConnected = (page: Page, label: string) =>
  expect
    .poll(() => socketConnected(page), {
      timeout: 30_000,
      message: `${label} socket never connected`,
    })
    .toBe(true);

const waitDisconnected = (page: Page, label: string) =>
  expect
    .poll(() => socketConnected(page), {
      timeout: 10_000,
      message: `${label} socket never disconnected`,
    })
    .toBe(false);

const waitRoomJoined = (page: Page, label: string) =>
  expect
    .poll(
      () => page.evaluate(() => (window as any).__EXCALIDASH_SOCKET_STATUS__?.roomJoined === true),
      {
        timeout: 30_000,
        message: `${label} socket connected but never rejoined the room`,
      },
    )
    .toBe(true);

const observeBrowserOffline = (page: Page) =>
  page.evaluate(
    (timeout) =>
      new Promise<boolean>((resolve) => {
        const onOffline = () => {
          window.clearTimeout(timer);
          resolve(true);
        };
        const timer = window.setTimeout(() => {
          window.removeEventListener("offline", onOffline);
          resolve(false);
        }, timeout);
        if (!navigator.onLine) {
          window.clearTimeout(timer);
          resolve(true);
          return;
        }
        window.addEventListener("offline", onOffline, { once: true });
      }),
    10_000,
  );

const errorToasts = (page: Page) => page.locator("[data-sonner-toast][data-type=error]");

// A toast for a specific rejected file, matched by the fileId sonner's own
// message names (`useEditorBroadcast.ts`'s "File <id> is too large ..."),
// not by count: sonner auto-dismisses after 4s (TOAST_LIFETIME) and, at
// least for this rejection path, re-fires a fresh toast for the same file
// on every later broadcast attempt until its element is removed -- both
// make a bare toast total a snapshot of something that is still moving, not a
// reliable signal of whether *this* rejection happened.
const errorToastFor = (page: Page, fileId: string) => errorToasts(page).filter({ hasText: fileId });

const refusedWidgetToast = (page: Page) =>
  errorToasts(page).filter({ hasText: "Document widget is not part of this board" });

const documentPageCount = async (page: Page) => {
  const label = await documentPageLabel(page).textContent();
  const match = label?.match(/^Page \d+ of (\d+)$/);
  return match ? Number(match[1]) : 0;
};

const observeOutboundFilePackets = (network: CDPSession) => {
  const packets: string[][] = [];
  network.on("Network.webSocketFrameSent", ({ response }: any) => {
    const payload = String(response?.payloadData || "");
    const marker = payload.indexOf('["element-update",');
    if (marker < 0) return;
    try {
      const packet = JSON.parse(payload.slice(marker));
      const files = packet?.[1]?.files;
      if (files && typeof files === "object") packets.push(Object.keys(files));
    } catch {
      // Engine.IO control frames and partial payloads are irrelevant.
    }
  });
  return packets;
};

const injectNoiseImageBatch = (page: Page, count: number, targetBytes: number) =>
  page.evaluate(
    async ({ count, targetBytes }) => {
      const api = (window as any).__EXCALIDASH_TEST__;
      if (!api) throw new Error("Missing __EXCALIDASH_TEST__");
      const files: Record<string, any> = {};
      const elements: any[] = [];
      const results: Array<{ dataHash: string; dataURLLength: number; fileId: string }> = [];

      for (let i = 0; i < count; i += 1) {
        const pixelCount = Math.ceil(targetBytes / 4);
        const width = Math.ceil(Math.sqrt(pixelCount));
        const height = Math.ceil(pixelCount / width);
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Missing 2D canvas context");
        const pixels = context.createImageData(width, height);
        const chunkBytes = 65_536;
        for (let offset = 0; offset < pixels.data.length; offset += chunkBytes) {
          crypto.getRandomValues(
            pixels.data.subarray(offset, Math.min(offset + chunkBytes, pixels.data.length)),
          );
        }
        context.putImageData(pixels, 0, 0);
        const dataURL = canvas.toDataURL("image/png");
        const binary = atob(dataURL.slice(dataURL.indexOf(",") + 1));
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        const dataDigest = await crypto.subtle.digest("SHA-256", bytes);
        const dataHash = Array.from(new Uint8Array(dataDigest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
        const fileDigest = await crypto.subtle.digest("SHA-1", bytes);
        const fileId = Array.from(new Uint8Array(fileDigest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
        const created = Date.now();
        const elementId = `nil330_split_${i}`;
        files[fileId] = {
          id: fileId,
          mimeType: "image/png",
          dataURL,
          created,
          lastRetrieved: created,
        };
        elements.push({
          id: elementId,
          type: "image",
          x: 40 + i * 140,
          y: 240,
          width: 120,
          height: 90,
          angle: 0,
          strokeColor: "#1e1e1e",
          backgroundColor: "transparent",
          fillStyle: "solid",
          strokeWidth: 1,
          strokeStyle: "solid",
          roundness: null,
          roughness: 0,
          opacity: 100,
          groupIds: [],
          frameId: null,
          seed: Math.floor(Math.random() * 1e9),
          version: 1,
          versionNonce: Math.floor(Math.random() * 1e9),
          isDeleted: false,
          boundElements: null,
          link: null,
          locked: false,
          index: `nil330_${Date.now()}_${i}`,
          updated: created,
          status: "saved",
          fileId,
          scale: [1, 1],
          crop: null,
        });
        results.push({ dataHash, dataURLLength: dataURL.length, fileId });
      }

      api.addFiles(files);
      api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), ...elements] });
      return results;
    },
    { count, targetBytes },
  );

const openPeer = async (context: BrowserContext, drawingId: string) =>
  openEditor(await context.newPage(), drawingId);

test.describe("M0 acceptance: guardrails hold together under combined pressure (NIL-330)", () => {
  test("large files, concurrent page turns, a mid-transfer drop and a vanished widget all land correctly on one board", async ({
    browser,
    request,
  }, testInfo) => {
    test.setTimeout(600_000);

    const drawing = await createDrawing(request, {
      name: `NIL330_TeamAcceptance_${Date.now()}`,
      elements: [],
      files: {},
    });

    const hostCtx = await browser.newContext();
    const guestACtx = await browser.newContext();
    const guestBCtx = await browser.newContext();

    try {
      const host = await openPeer(hostCtx, drawing.id);
      const guestA = await openPeer(guestACtx, drawing.id);
      const guestB = await openPeer(guestBCtx, drawing.id);
      await Promise.all([
        waitConnected(host, "host"),
        waitConnected(guestA, "guestA"),
        waitConnected(guestB, "guestB"),
      ]);

      let widgetId = "";

      await test.step("a paginated document widget is visible to every peer", async () => {
        const markdown = Array.from(
          { length: 120 },
          (_, i) => `## Section ${i + 1}\n\n${`Body text for section ${i + 1}. `.repeat(30)}\n`,
        ).join("\n");
        await dropMarkdown(host, markdown);
        await expect(documentPageLabel(host)).toContainText("Page 1 of", { timeout: 30_000 });
        await expect(documentPageLabel(guestA)).toContainText("Page 1 of", { timeout: 30_000 });
        await expect(documentPageLabel(guestB)).toContainText("Page 1 of", { timeout: 30_000 });
        await Promise.all(
          [host, guestA, guestB].map((page) =>
            expect
              .poll(() => documentPageCount(page), {
                timeout: 30_000,
                message: "three forward page turns require at least four document pages",
              })
              .toBeGreaterThanOrEqual(4),
          ),
        );
        const widgets = await host.evaluate(() =>
          (window as any).__EXCALIDASH_TEST__.getSceneElements(),
        );
        expect(widgets).toHaveLength(1);
        widgetId = widgets[0].id;
        expect(widgetId).toBeTruthy();
      });

      await test.step("a 2 MB file syncs silently; 14 MB, 15 MB and an over-ceiling file are refused, not lost", async () => {
        const okImage = await injectNoiseImage(host, {
          withHash: true,
          targetBytes: 2 * 1024 * 1024,
          elementId: "nil330_ok",
        });
        expect(await waitForPeerFile(guestA, okImage.fileId)).toBe(okImage.dataHash);
        expect(await waitForPeerFile(guestB, okImage.fileId)).toBe(okImage.dataHash);

        for (const [label, targetBytes] of [
          ["14 MB", 14 * 1024 * 1024],
          ["15 MB", 15 * 1024 * 1024],
          ["above the transport ceiling (20 MB)", 20 * 1024 * 1024],
        ] as const) {
          const oversized = await injectNoiseImage(host, {
            withHash: true,
            targetBytes,
            elementId: `nil330_oversized_${label.replace(/\W+/g, "")}`,
          });
          await expect(errorToastFor(host, oversized.fileId).first()).toBeVisible({
            timeout: 15_000,
          });
          // Refused, not silently dropped mid-flight: the connection stays up
          // and the peers never see a file that was never actually sent.
          await waitConnected(host, `host after ${label} rejection`);
          const arrivedOnGuest = await guestA.evaluate(
            (id) => Boolean((window as any).__EXCALIDASH_TEST__?.getFiles?.()?.[id]),
            oversized.fileId,
          );
          expect(arrivedOnGuest).toBe(false);

          // The rejected image stays in Excalidraw's own local file store --
          // that half is unrelated to the collaboration guardrail under test
          // here and is out of scope for this package. Removing the element
          // again keeps the board's own periodic full-scene autosave from
          // repeatedly retrying (and failing) on a file this test intentionally
          // made too large for the rest of this run.
          await host.evaluate(
            (elementId) => {
              const api = (window as any).__EXCALIDASH_TEST__;
              api.updateScene({
                elements: api
                  .getSceneElementsIncludingDeleted()
                  .map((element: any) =>
                    element.id === elementId ? { ...element, isDeleted: true } : element,
                  ),
              });
            },
            `nil330_oversized_${label.replace(/\W+/g, "")}`,
          );
        }
      });

      await test.step("three files split across packets are all confirmed on every peer", async () => {
        const network = await hostCtx.newCDPSession(host);
        await network.send("Network.enable");
        const outboundFilePackets = observeOutboundFilePackets(network);
        const batch = await injectNoiseImageBatch(host, 3, 4 * 1024 * 1024);
        for (const file of batch) {
          expect(await waitForPeerFile(guestA, file.fileId)).toBe(file.dataHash);
          expect(await waitForPeerFile(guestB, file.fileId)).toBe(file.dataHash);
        }
        const batchIds = new Set(batch.map((file) => file.fileId));
        const matchingPackets = outboundFilePackets.filter((fileIds) =>
          fileIds.some((fileId) => batchIds.has(fileId)),
        );
        expect(new Set(matchingPackets.flat())).toEqual(batchIds);
        expect(
          new Set(matchingPackets.map((fileIds) => [...fileIds].sort().join(","))).size,
        ).toBeGreaterThan(1);
        await network.detach();
      });

      await test.step("three concurrent page turns converge on the same server-decided page", async () => {
        await activateDocumentWidget(host);
        await activateDocumentWidget(guestA);
        await activateDocumentWidget(guestB);
        const nextPageButtons = [host, guestA, guestB].map((page) =>
          page.getByRole("button", { name: "Next page" }),
        );
        await Promise.all(
          nextPageButtons.map((button) => expect(button).toBeEnabled({ timeout: 10_000 })),
        );
        // Not asserting a specific target page: a local click races the
        // round trip of the other two, so which page the room lands on
        // depends on the order the server actually received them in -- that
        // order is exactly what is under test, not a page number picked in
        // advance. What every client must agree on is the *same* page,
        // whichever one the server decided.
        // Arm all three browser contexts before releasing any click. Three
        // Playwright `locator.click()` calls are not an atomic barrier: one
        // can still be doing actionability checks when another client's
        // accepted revision temporarily disables its button. Resolving and
        // storing every real role-matched DOM button first makes readiness a
        // two-phase condition rather than a guessed timing window.
        await Promise.all(
          nextPageButtons.map((button) =>
            button.evaluate(
              (element) => {
                if (!(element instanceof HTMLButtonElement) || element.disabled) {
                  throw new Error("Could not arm an enabled Next page button");
                }
                (window as any).__NIL546_ARMED_NEXT_PAGE__ = element;
              },
              { timeout: 10_000 },
            ),
          ),
        );
        await Promise.all(
          [host, guestA, guestB].map((page) =>
            page.evaluate(() => {
              const button = (window as any).__NIL546_ARMED_NEXT_PAGE__;
              delete (window as any).__NIL546_ARMED_NEXT_PAGE__;
              if (!(button instanceof HTMLButtonElement) || button.disabled) {
                throw new Error("Next page became disabled before the concurrent release");
              }
              button.click();
            }),
          ),
        );
        // Comparing guestA/guestB against a snapshot of host's page taken
        // the instant host first moves races a peer whose own click settles
        // later (real network/dispatch timing, not a bug): if that peer
        // observes an earlier broadcast before its own click fires, it
        // legitimately computes one page further and moves the whole room
        // again -- and nothing moves it back, so a comparison against the
        // earlier snapshot never matches again (NIL-526). Wait for all
        // three to agree with each other instead of with one snapshot. Every
        // button becoming enabled again is the observable completion signal
        // for its request promise; only after all three requests have settled
        // can a matching set of labels be the final server-decided page.
        await Promise.all(
          nextPageButtons.map((button) => expect(button).toBeEnabled({ timeout: 15_000 })),
        );
        const pageTexts = () =>
          Promise.all([host, guestA, guestB].map((page) => documentPageLabel(page).textContent()));
        await expect
          .poll(
            async () => {
              const texts = await pageTexts();
              return new Set(texts).size === 1 ? texts[0] : null;
            },
            { timeout: 20_000, message: "expected all three peers to converge on the same page" },
          )
          .not.toBeNull();
        const settled = await pageTexts();
        expect(
          new Set(settled).size,
          `expected the converged page to hold: ${settled.join(", ")}`,
        ).toBe(1);
        expect(settled[0]).toMatch(/^Page (?!1 of )\d+ of \d+$/);
      });

      await test.step("a network drop mid-transfer resets unconfirmed state instead of leaving a ghost", async () => {
        const network = await hostCtx.newCDPSession(host);
        await network.send("Network.enable");
        const outboundFilePackets = observeOutboundFilePackets(network);
        await network.send("Network.emulateNetworkConditions", {
          offline: false,
          latency: 20,
          downloadThroughput: 10 * 1024 * 1024,
          uploadThroughput: 1024 * 1024,
        });

        const probe = await injectNoiseImage(host, {
          withHash: true,
          targetBytes: 6 * 1024 * 1024,
          elementId: "nil330_reconnect_probe",
        });
        await expect
          .poll(() => outboundFilePackets.some((fileIds) => fileIds.includes(probe.fileId)), {
            timeout: 30_000,
            message: "the reconnect probe never entered the WebSocket transport",
          })
          .toBe(true);
        await host.evaluate(() => {
          const status = (window as any).__EXCALIDASH_SOCKET_STATUS__;
          if (typeof status?.dropTransport !== "function") {
            throw new Error("Missing Socket.IO transport-drop test control");
          }
          status.dropTransport();
        });
        await waitDisconnected(host, "host after forced transport drop");

        // Queue fresh work before the room is rejoined. NIL-533 gives files a
        // fair delivery lane, so this update must not park forever behind the
        // interrupted large attempt.
        const followUp = await injectNoiseImage(host, {
          withHash: true,
          targetBytes: 1 * 1024 * 1024,
          elementId: "nil330_after_reconnect",
        });
        await waitConnected(host, "host after reconnect");
        await waitRoomJoined(host, "host after reconnect");
        expect(await waitForPeerFile(guestA, followUp.fileId)).toBe(followUp.dataHash);

        await network.send("Network.emulateNetworkConditions", {
          offline: false,
          latency: 0,
          downloadThroughput: -1,
          uploadThroughput: -1,
        });

        // The interrupted probe may have landed before the cut or may need a
        // retry after it. Either result is valid, but a partial/corrupt file
        // is not: if it arrives, its bytes must still match exactly.
        const arrived = await guestA
          .waitForFunction(
            (id) => Boolean((window as any).__EXCALIDASH_TEST__?.getFiles?.()?.[id]),
            probe.fileId,
            { timeout: 90_000 },
          )
          .then(() => true)
          .catch(() => false);
        if (arrived) {
          expect(await waitForPeerFile(guestA, probe.fileId)).toBe(probe.dataHash);
        }
      });

      await test.step("a widget that stops existing mid-request is refused, not hung, and surfaces to the user", async () => {
        // guestB is put offline before the widget is removed and the removal
        // is force-saved, so guestB's later click is guaranteed to reach a
        // server that has already forgotten the widget -- the exact race a
        // stale collaborator produces, made deterministic instead of hoping
        // real network timing reproduces it.
        const guestBOffline = observeBrowserOffline(guestB);
        await guestBCtx.setOffline(true);
        expect(
          await guestBOffline,
          "guestB never observed the forced offline state before widget deletion",
        ).toBe(true);

        const hostElements = await host.evaluate(() =>
          (window as any).__EXCALIDASH_TEST__.getSceneElementsIncludingDeleted(),
        );
        const withoutWidget = hostElements.map((element: any) =>
          element.id === widgetId ? { ...element, isDeleted: true } : element,
        );
        await host.evaluate(
          (elements) => (window as any).__EXCALIDASH_TEST__.updateScene({ elements }),
          withoutWidget,
        );
        // host's own debounced autosave is a second, independent writer of
        // this same drawing's version -- refetch-and-retry rather than a
        // single read-then-write, so a save that lands between the version
        // read and this PUT does not fail the whole step.
        for (let attempt = 0; ; attempt += 1) {
          const current = await getDrawing(request, drawing.id);
          try {
            await updateDrawing(request, drawing.id, {
              elements: withoutWidget,
              version: current.version,
            });
            break;
          } catch (err) {
            if (attempt >= 5 || !String(err).includes("VERSION_CONFLICT")) throw err;
          }
        }

        // Still showing the widget locally (guestB has not received the
        // deletion broadcast while offline) -- click through it anyway. The
        // socket.io client queues the request; it is delivered the moment
        // guestB reconnects, against a server that has already committed the
        // deletion.
        // Re-activate: Excalidraw deactivates an embeddable's own controls
        // once the pointer interacts with anything else on the canvas
        // (several other steps above did), the same way it guards an
        // embedded video. Purely local, so this works the same offline.
        await activateDocumentWidget(guestB);
        await guestB.getByRole("button", { name: "Next page" }).click({ timeout: 5_000 });

        await guestBCtx.setOffline(false);
        await waitConnected(guestB, "guestB after reconnect");

        const refusalToast = refusedWidgetToast(guestB).first();
        await expect(refusalToast).toBeVisible({ timeout: 15_000 });

        // Visual evidence for this package's HANDOFF: the fix in
        // EditorView.tsx (surfacing a refused document-page request) is a
        // frontend product change, and this is the one point in the run
        // where its effect is actually on screen. sonner mounts the toast
        // and then animates it in (translateY + opacity). Playwright's
        // `toBeVisible` deliberately treats opacity:0 as visible, so wait for
        // sonner's own mounted state and the computed end opacity instead of
        // sleeping for an assumed animation duration.
        await expect
          .poll(
            () =>
              refusalToast.evaluate(
                (element) =>
                  element.getAttribute("data-mounted") === "true" &&
                  Number(getComputedStyle(element).opacity) === 1,
              ),
            { timeout: 5_000, message: "expected the refusal toast to finish animating in" },
          )
          .toBe(true);
        const screenshotPath = testInfo.outputPath("guestB-refused-page-request-toast.png");
        await guestB.screenshot({ path: screenshotPath });
        await testInfo.attach("guestB-refused-page-request-toast", {
          path: screenshotPath,
          contentType: "image/png",
        });

        // Not hung, not crashed: guestB's harness is still responsive.
        const stillResponsive = await guestB.evaluate(() =>
          Array.isArray((window as any).__EXCALIDASH_TEST__?.getSceneElements?.()),
        );
        expect(stillResponsive).toBe(true);
      });

      await test.step("every peer is still connected at the end", async () => {
        await Promise.all([
          waitConnected(host, "host"),
          waitConnected(guestA, "guestA"),
          waitConnected(guestB, "guestB"),
        ]);
      });
    } finally {
      await hostCtx.close();
      await guestACtx.close();
      await guestBCtx.close();
      await deleteDrawing(request, drawing.id);
    }
  });
});
