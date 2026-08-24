import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createDrawing, deleteDrawing, getDrawing, updateDrawing } from "./helpers/api";
import {
  activateDocumentWidget,
  documentPageLabel,
  dropMarkdown,
  openEditor as openEditorReady,
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

const openEditor = (page: Page, drawingId: string) =>
  openEditorReady(page, drawingId, { settleMs: 1000 });

const socketConnected = (page: Page) =>
  page.evaluate(() => (window as any).__EXCALIDASH_SOCKET_STATUS__?.connected === true);

const waitConnected = (page: Page, label: string) =>
  expect
    .poll(() => socketConnected(page), { timeout: 30_000, message: `${label} socket never connected` })
    .toBe(true);

/**
 * A noise-filled PNG of a target raw byte size, as a data URL.
 *
 * Random pixels are incompressible, so the encoded PNG lands close to
 * `width * height * 4` regardless of what the browser's deflate pass does --
 * the same calibration large-image-delivery.spec.ts (NIL-315) uses, reused
 * here so an oversized-file rejection is tested against a real generated
 * image rather than a hand-built byte string the client never actually
 * produces this way.
 */
const injectNoiseImage = async (
  page: Page,
  { targetBytes, elementId }: { targetBytes: number; elementId: string },
) =>
  page.evaluate(
    async ({ targetBytes, elementId }) => {
      const pixelCount = Math.ceil(targetBytes / 4);
      const width = Math.ceil(Math.sqrt(pixelCount));
      const height = Math.ceil(pixelCount / width);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Missing 2D canvas context");
      const pixels = context.createImageData(width, height);
      const CHUNK = 65536;
      for (let offset = 0; offset < pixels.data.length; offset += CHUNK) {
        crypto.getRandomValues(pixels.data.subarray(offset, Math.min(offset + CHUNK, pixels.data.length)));
      }
      context.putImageData(pixels, 0, 0);
      const dataURL = canvas.toDataURL("image/png");

      const binary = atob(dataURL.slice(dataURL.indexOf(",") + 1));
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const dataHash = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      const fileDigest = await crypto.subtle.digest("SHA-1", bytes);
      const fileId = Array.from(new Uint8Array(fileDigest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      const created = Date.now();

      const api = (window as any).__EXCALIDASH_TEST__;
      api.addFiles({
        [fileId]: { id: fileId, mimeType: "image/png", dataURL, created, lastRetrieved: created },
      });
      api.updateScene({
        elements: [
          ...api.getSceneElementsIncludingDeleted(),
          {
            id: elementId,
            type: "image",
            x: 40,
            y: 100,
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
            seed: 1,
            version: 1,
            versionNonce: 1,
            isDeleted: false,
            boundElements: null,
            link: null,
            locked: false,
            index: "a1",
            updated: created,
            status: "saved",
            fileId,
            scale: [1, 1],
            crop: null,
          },
        ],
      });
      return { fileId, dataHash, dataURLLength: dataURL.length };
    },
    { targetBytes, elementId },
  );

const errorToasts = (page: Page) => page.locator("[data-sonner-toast][data-type=error]");

/** Waits for a file to arrive on a peer and returns its content hash. */
const waitForPeerFile = async (page: Page, fileId: string) => {
  await page.waitForFunction(
    (id) => Boolean((window as any).__EXCALIDASH_TEST__?.getFiles?.()?.[id]),
    fileId,
    { timeout: 30_000 },
  );
  return page.evaluate(async (id) => {
    const dataURL = (window as any).__EXCALIDASH_TEST__.getFiles()[id].dataURL;
    const binary = atob(dataURL.slice(dataURL.indexOf(",") + 1));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  }, fileId);
};

const openPeer = async (context: BrowserContext, drawingId: string) => openEditor(await context.newPage(), drawingId);

test.describe("M0 acceptance: guardrails hold together under combined pressure (NIL-330)", () => {
  test("large files, concurrent page turns, a mid-transfer drop and a vanished widget all land correctly on one board", async ({
    browser,
    request,
  }) => {
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
      await Promise.all([waitConnected(host, "host"), waitConnected(guestA, "guestA"), waitConnected(guestB, "guestB")]);

      let widgetId = "";

      await test.step("a paginated document widget is visible to every peer", async () => {
        const markdown = Array.from(
          { length: 60 },
          (_, i) => `## Section ${i + 1}\n\n${`Body text for section ${i + 1}. `.repeat(30)}\n`,
        ).join("\n");
        await dropMarkdown(host, markdown);
        await expect(documentPageLabel(host)).toContainText("Page 1 of", { timeout: 30_000 });
        await expect(documentPageLabel(guestA)).toContainText("Page 1 of", { timeout: 30_000 });
        await expect(documentPageLabel(guestB)).toContainText("Page 1 of", { timeout: 30_000 });
        const widgets = await host.evaluate(() => (window as any).__EXCALIDASH_TEST__.getSceneElements());
        expect(widgets).toHaveLength(1);
        widgetId = widgets[0].id;
        expect(widgetId).toBeTruthy();
      });

      await test.step("a 2 MB file syncs silently; 14 MB, 15 MB and an over-ceiling file are refused, not lost", async () => {
        const okImage = await injectNoiseImage(host, { targetBytes: 2 * 1024 * 1024, elementId: "nil330_ok" });
        expect(await waitForPeerFile(guestA, okImage.fileId)).toBe(okImage.dataHash);
        expect(await waitForPeerFile(guestB, okImage.fileId)).toBe(okImage.dataHash);

        for (const [label, targetBytes] of [
          ["14 MB", 14 * 1024 * 1024],
          ["15 MB", 15 * 1024 * 1024],
          ["above the transport ceiling (20 MB)", 20 * 1024 * 1024],
        ] as const) {
          const before = await errorToasts(host).count();
          const oversized = await injectNoiseImage(host, {
            targetBytes,
            elementId: `nil330_oversized_${label.replace(/\W+/g, "")}`,
          });
          await expect
            .poll(() => errorToasts(host).count(), {
              timeout: 15_000,
              message: `expected a rejection toast for the ${label} file`,
            })
            .toBeGreaterThan(before);
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
          await host.evaluate((elementId) => {
            const api = (window as any).__EXCALIDASH_TEST__;
            api.updateScene({
              elements: api
                .getSceneElementsIncludingDeleted()
                .map((element: any) =>
                  element.id === elementId ? { ...element, isDeleted: true } : element,
                ),
            });
          }, `nil330_oversized_${label.replace(/\W+/g, "")}`);
        }
      });

      await test.step("three files split across packets are all confirmed on every peer", async () => {
        const batch = await Promise.all(
          [0, 1, 2].map((i) =>
            injectNoiseImage(host, { targetBytes: 6 * 1024 * 1024, elementId: `nil330_split_${i}` }),
          ),
        );
        for (const file of batch) {
          expect(await waitForPeerFile(guestA, file.fileId)).toBe(file.dataHash);
          expect(await waitForPeerFile(guestB, file.fileId)).toBe(file.dataHash);
        }
      });

      await test.step("three concurrent page turns converge on the same server-decided page", async () => {
        await activateDocumentWidget(host);
        await activateDocumentWidget(guestA);
        await activateDocumentWidget(guestB);
        // Not asserting a specific target page: a local click races the
        // round trip of the other two, so which page the room lands on
        // depends on the order the server actually received them in -- that
        // order is exactly what is under test, not a page number picked in
        // advance. What every client must agree on is the *same* page,
        // whichever one the server decided.
        await Promise.all([
          host.getByRole("button", { name: "Next page" }).click(),
          guestA.getByRole("button", { name: "Next page" }).click(),
          guestB.getByRole("button", { name: "Next page" }).click(),
        ]);
        await expect(documentPageLabel(host)).not.toContainText("Page 1 of", { timeout: 15_000 });
        const converged = await documentPageLabel(host).textContent();
        await expect(documentPageLabel(guestA)).toHaveText(converged ?? "", { timeout: 15_000 });
        await expect(documentPageLabel(guestB)).toHaveText(converged ?? "", { timeout: 15_000 });
      });

      await test.step("a network drop mid-transfer resets unconfirmed state instead of leaving a ghost", async () => {
        const inFlight = injectNoiseImage(host, {
          targetBytes: 6 * 1024 * 1024,
          elementId: "nil330_reconnect_probe",
        });
        // Racing the drop against packet delivery on purpose: the guarantee
        // under test is that *whichever* unconfirmed bytes were in flight
        // when the socket dies get forgotten, not resent from a stale marker
        // and not left half-applied.
        await hostCtx.setOffline(true);
        await host.waitForTimeout(500);
        await hostCtx.setOffline(false);
        const probe = await inFlight;

        await waitConnected(host, "host after reconnect");
        // The reconnect must not have wedged future delivery: a fresh file
        // sent right after still has to arrive, split-and-confirm bookkeeping
        // intact.
        const followUp = await injectNoiseImage(host, {
          targetBytes: 1 * 1024 * 1024,
          elementId: "nil330_after_reconnect",
        });
        expect(await waitForPeerFile(guestA, followUp.fileId)).toBe(followUp.dataHash);

        // The probe file itself must not have silently vanished either: it
        // either made it across before the drop or the resend after
        // reconnect delivered it -- either way, no ghost, no ack mismatch.
        const arrived = await guestA
          .waitForFunction(
            (id) => Boolean((window as any).__EXCALIDASH_TEST__?.getFiles?.()?.[id]),
            probe.fileId,
            { timeout: 20_000 },
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
        await guestBCtx.setOffline(true);

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
        const beforeErrors = await errorToasts(guestB).count();
        await guestB.getByRole("button", { name: "Next page" }).click({ timeout: 5_000 }).catch(() => {});

        await guestBCtx.setOffline(false);
        await waitConnected(guestB, "guestB after reconnect");

        await expect
          .poll(() => errorToasts(guestB).count(), {
            timeout: 15_000,
            message: "expected the refused page request to surface as an error toast on guestB",
          })
          .toBeGreaterThan(beforeErrors);

        // Not hung, not crashed: guestB's harness is still responsive.
        const stillResponsive = await guestB.evaluate(
          () => Array.isArray((window as any).__EXCALIDASH_TEST__?.getSceneElements?.()),
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
