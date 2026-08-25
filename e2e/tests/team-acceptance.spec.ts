import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createDrawing, deleteDrawing, getDrawing, updateDrawing } from "./helpers/api";
import {
  activateDocumentWidget,
  deliveryState,
  documentPageLabel,
  dropMarkdown,
  peerFile,
  type DeliveryState,
  type PeerFile,
  injectNoiseImage,
  injectNoiseImageBatch,
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
 *
 * Waiting policy (2026-08-24, after 2 green in 52 CI runs):
 *
 * Every wait in this file is for a *state*, never for a duration, and every
 * state is confirmed at the hop where it happens. A file travels three hops
 * -- queued on the sender, acknowledged by the server, present on the peer --
 * and "the peer does not have it after 30 s" is one observation that hides
 * three different failures. `__EXCALIDASH_TEST__.getDeliveryState()` exposes
 * the sender's queue, so each hop is asserted in order and a red run names
 * the hop that failed.
 *
 * The timeouts are ceilings, not pacing: a 120 s ceiling costs nothing when
 * the state arrives in 3 s, and it exists only so a genuinely stuck run
 * still ends with a report and a trace. They are sized for a shared CI
 * runner with three browser contexts, an unbundled Vite dev server and the
 * backend on the same four cores -- where a bare `navigator.onLine` read
 * has been observed to take nine seconds -- not for a developer laptop.
 * There is no fixed sleep in this file.
 */

const CEILING = {
  /** Server-side ack of a file the sender queued. */
  ack: 120_000,
  /** A file present on a peer after the server acked it. */
  peer: 60_000,
  /** A toast, a label, a button state -- anything rendered locally. */
  ui: 30_000,
} as const;

const openEditor = (page: Page, drawingId: string) => openEditorReady(page, drawingId);

const socketConnected = (page: Page) =>
  page.evaluate(() => (window as any).__EXCALIDASH_SOCKET_STATUS__?.connected === true);

const waitConnected = (page: Page, label: string) =>
  expect
    .poll(() => socketConnected(page), {
      timeout: CEILING.ui,
      message: `${label} socket never connected`,
    })
    .toBe(true);

const errorToasts = (page: Page) => page.locator("[data-sonner-toast][data-type=error]");

// Match the rejected image by the canvas location the product shows, not by
// toast count. Sonner auto-dismisses after 4s, while several images can be
// refused in one workflow; a bare total cannot say which placed image the
// message described.
const oversizedImageToastAt = (page: Page, x: number, y: number) =>
  errorToasts(page).filter({ hasText: `canvas position (${x}, ${y})` });

const refusedWidgetToast = (page: Page) =>
  errorToasts(page).filter({ hasText: "Document widget is not part of this board" });

const documentPageCount = async (page: Page) => {
  const label = await documentPageLabel(page).textContent();
  const match = label?.match(/^Page \d+ of (\d+)$/);
  return match ? Number(match[1]) : 0;
};

/**
 * Poll the sender's queue for a condition. On timeout the error carries a
 * timeline of the `DeliveryState` samples seen while waiting (one per
 * change, so a retry storm shows as alternating `retrying` flags and a
 * genuine wedge as one unchanging line), so a red run says what the queue
 * was doing instead of only that it did not do it in time.
 */
const waitForDelivery = async (
  page: Page,
  condition: (state: DeliveryState) => boolean,
  { label, timeout }: { label: string; timeout: number },
) => {
  const startedAt = Date.now();
  const timeline: string[] = [];
  let lastLine = "";
  try {
    await expect
      .poll(
        async () => {
          const state = await deliveryState(page);
          const line = state
            ? `inFlight=${state.inFlight} parked=${state.parked} retrying=${state.retrying} acked=${state.acknowledgedFileIds.length} rejected=${state.rejectedFileIds.length}`
            : "no harness";
          if (line !== lastLine) {
            lastLine = line;
            timeline.push(`+${((Date.now() - startedAt) / 1000).toFixed(1)}s ${line}`);
            if (timeline.length > 80) timeline.splice(0, timeline.length - 80);
          }
          return state ? condition(state) : false;
        },
        { timeout, intervals: [250, 500, 1_000], message: label },
      )
      .toBe(true);
  } catch (error) {
    const stalls = await recentStalls(page).catch(() => "unavailable");
    throw new Error(
      `${label}\n  delivery timeline:\n    ${timeline.join("\n    ")}\n  sender main-thread stalls (page-time:+gap): ${stalls}`,
      { cause: error },
    );
  }
};

/** Hop 2: the server acknowledged this file to the sender. */
const waitForServerAck = (page: Page, fileId: string, label: string) =>
  waitForDelivery(page, (state) => state.acknowledgedFileIds.includes(fileId), {
    label: `${label}: the server never acknowledged file ${fileId} to the sender`,
    timeout: CEILING.ack,
  });

/** Hop 1 (negative): the sender itself refused this file as too large. */
const waitForLocalRejection = (page: Page, fileId: string, label: string) =>
  waitForDelivery(page, (state) => state.rejectedFileIds.includes(fileId), {
    label: `${label}: the sender never recorded file ${fileId} as rejected`,
    timeout: CEILING.ui,
  });

/**
 * Hop 3: the file is on the peer, and it is this file. Byte identity when the
 * peer holds the live inline copy; image identity (decodes, original
 * dimensions) when it holds the blob store's re-encoded copy after a rebase
 * -- see `peerFile` for why both are legitimate. The split batch uses three
 * different sizes so that dimensions alone tell the three files apart.
 */
const expectPeerFile = async (
  page: Page,
  file: { fileId: string; dataHash?: string; width: number; height: number },
  label: string,
) => {
  let received: PeerFile | null = null;
  await expect
    .poll(
      async () => {
        received = await peerFile(page, file.fileId);
        return received !== null;
      },
      {
        timeout: CEILING.peer,
        message: `${label}: file ${file.fileId} never arrived on the peer`,
      },
    )
    .toBe(true);
  const got = received as unknown as PeerFile;
  const where = `${label}: file ${file.fileId} (${got.source} copy, ${got.byteLength} bytes)`;
  expect(got.width, `${where}: width`).toBe(file.width);
  expect(got.height, `${where}: height`).toBe(file.height);
  if (got.source === "inline") {
    expect(got.hash, `${where}: bytes`).toBe(file.dataHash);
  }
};

const openPeer = async (context: BrowserContext, drawingId: string) =>
  openEditor(await context.newPage(), drawingId);

/**
 * Records main-thread stalls on a page: a 100 ms interval whose gap grows
 * past 500 ms means nothing else ran either -- no socket ack callback, no
 * retry timer. A delivery timeline that shows a 1 s retry delay taking 15 s
 * is explained by this list, not by the server.
 */
const watchStalls = (page: Page) =>
  page.evaluate(() => {
    const stalls: Array<[number, number]> = [];
    (window as any).__NIL330_STALLS__ = stalls;
    let last = performance.now();
    setInterval(() => {
      const now = performance.now();
      const gap = now - last - 100;
      if (gap > 500) stalls.push([Math.round(now / 1000), Math.round(gap)]);
      last = now;
    }, 100);
  });

const recentStalls = (page: Page) =>
  page.evaluate(() => {
    const stalls: Array<[number, number]> = (window as any).__NIL330_STALLS__ ?? [];
    return stalls
      .slice(-12)
      .map(([at, gap]) => `${at}s:+${gap}ms`)
      .join(" ");
  });

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

      await watchStalls(host);

      let widgetId = "";

      await test.step("a paginated document widget is visible to every peer", async () => {
        const markdown = Array.from(
          { length: 120 },
          (_, i) => `## Section ${i + 1}\n\n${`Body text for section ${i + 1}. `.repeat(30)}\n`,
        ).join("\n");
        await dropMarkdown(host, markdown);
        await expect(documentPageLabel(host)).toContainText("Page 1 of", { timeout: CEILING.ui });
        await expect(documentPageLabel(guestA)).toContainText("Page 1 of", { timeout: CEILING.ui });
        await expect(documentPageLabel(guestB)).toContainText("Page 1 of", { timeout: CEILING.ui });
        await Promise.all(
          [host, guestA, guestB].map((page) =>
            expect
              .poll(() => documentPageCount(page), {
                timeout: CEILING.ui,
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
        await waitForServerAck(host, okImage.fileId, "2 MB file");
        await expectPeerFile(guestA, okImage, "2 MB file on guestA");
        await expectPeerFile(guestB, okImage, "2 MB file on guestB");

        for (const [imageIndex, [label, targetBytes]] of [
          ["14 MB", 14 * 1024 * 1024],
          ["15 MB", 15 * 1024 * 1024],
          ["above the transport ceiling (20 MB)", 20 * 1024 * 1024],
        ].entries()) {
          const position = { x: 80 + imageIndex * 180, y: 120 };
          const oversized = await injectNoiseImage(host, {
            withHash: true,
            targetBytes,
            elementId: `nil330_oversized_${label.replace(/\W+/g, "")}`,
            position,
          });
          // The refusal is a local decision (`splitFilesIntoUpdatePayloads`
          // never lets the file onto the wire); the queue records it before
          // sonner has rendered anything, so check the record first and the
          // user-visible toast second.
          await waitForLocalRejection(host, oversized.fileId, label);
          const rejectionToast = oversizedImageToastAt(host, position.x, position.y).first();
          await expect(rejectionToast).toBeVisible({
            timeout: CEILING.ui,
          });
          await expect(rejectionToast).not.toContainText(oversized.fileId);
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
        const batch = await injectNoiseImageBatch(
          host,
          [4.25, 4.5, 4.75].map((megabytes, i) => ({
            withHash: true,
            // Three sizes, so three different image dimensions: a peer
            // holding the right bytes under the wrong id shows up as a
            // dimension mismatch instead of passing three identical checks.
            targetBytes: Math.round(megabytes * 1024 * 1024),
            elementId: `nil330_split_${i}`,
            position: { x: 40 + i * 140, y: 240 },
          })),
        );
        const dataUrlLengths = batch.map((file) => file.dataURLLength).sort((a, b) => a - b);
        expect(dataUrlLengths).toHaveLength(3);
        expect(Math.max(...dataUrlLengths)).toBeLessThan(10 * 1024 * 1024);
        // The live packet ceiling is 11 MiB. Even the two smallest files do
        // not fit together, so this one atomic addFiles call must become at
        // least three packets; the assertion keeps reduced fixture sizes from
        // silently weakening the split contract.
        expect(dataUrlLengths[0] + dataUrlLengths[1]).toBeGreaterThan(11 * 1024 * 1024);
        // Sender first: every target packet acked. Only then does a missing
        // target file on a peer mean what it says. #98 intentionally lets
        // later metadata refreshes continue independently; global queue idle
        // is not part of this file-delivery contract.
        for (const file of batch) {
          await waitForServerAck(host, file.fileId, "split batch");
        }
        for (const file of batch) {
          await expectPeerFile(guestA, file, "split batch on guestA");
          await expectPeerFile(guestB, file, "split batch on guestB");
        }
      });

      await test.step("three concurrent page turns converge on the same server-decided page", async () => {
        await activateDocumentWidget(host);
        await activateDocumentWidget(guestA);
        await activateDocumentWidget(guestB);
        const nextPageButtons = [host, guestA, guestB].map((page) =>
          page.getByRole("button", { name: "Next page" }),
        );
        await Promise.all(
          nextPageButtons.map((button) => expect(button).toBeEnabled({ timeout: CEILING.ui })),
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
              { timeout: CEILING.ui },
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
        await expect(documentPageLabel(host)).not.toContainText("Page 1 of", {
          timeout: CEILING.ui,
        });

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
          nextPageButtons.map((button) => expect(button).toBeEnabled({ timeout: CEILING.ui })),
        );
        const pageTexts = () =>
          Promise.all([host, guestA, guestB].map((page) => documentPageLabel(page).textContent()));
        await expect
          .poll(
            async () => {
              const texts = await pageTexts();
              return new Set(texts).size === 1 ? texts[0] : null;
            },
            {
              timeout: CEILING.ui,
              message: "expected all three peers to converge on the same page",
            },
          )
          .not.toBeNull();
        const settled = await pageTexts();
        expect(
          new Set(settled).size,
          `expected the converged page to hold: ${settled.join(", ")}`,
        ).toBe(1);
      });

      await test.step("a network drop mid-transfer resets unconfirmed state instead of leaving a ghost", async () => {
        const inFlight = injectNoiseImage(host, {
          withHash: true,
          targetBytes: 6 * 1024 * 1024,
          elementId: "nil330_reconnect_probe",
        });
        // Racing the drop against packet delivery on purpose: the guarantee
        // under test is that *whichever* unconfirmed bytes were in flight
        // when the socket dies get forgotten, not resent from a stale marker
        // and not left half-applied. `setOffline` resolves once the browser
        // has applied the condition -- there is nothing further to observe
        // before lifting it again.
        await hostCtx.setOffline(true);
        const probe = await inFlight;
        await hostCtx.setOffline(false);

        await waitConnected(host, "host after reconnect");

        // Hop by hop. The probe was queued while the socket died; after the
        // reconnect the server has to ack it (a resend from a clean marker,
        // not a ghost), and then the peer's copy is compared. #98 replaced
        // global queue-idle with per-file fairness: the fresh follow-up below
        // passing all three hops is the observable proof that nothing older
        // can head-of-line-block it.
        await waitForServerAck(host, probe.fileId, "reconnect probe");
        await expectPeerFile(guestA, probe, "reconnect probe on guestA");

        // The reconnect must not have wedged future delivery: a fresh file
        // sent now still has to travel all three hops with split-and-confirm
        // bookkeeping intact.
        const followUp = await injectNoiseImage(host, {
          withHash: true,
          targetBytes: 1 * 1024 * 1024,
          elementId: "nil330_after_reconnect",
        });
        await waitForServerAck(host, followUp.fileId, "post-reconnect file");
        await expectPeerFile(guestA, followUp, "post-reconnect file on guestA");
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
        // Re-activate: Excalidraw deactivates an embeddable's own controls
        // once the pointer interacts with anything else on the canvas
        // (several other steps above did), the same way it guards an
        // embedded video. Purely local, so this works the same offline.
        await activateDocumentWidget(guestB);
        await guestB.getByRole("button", { name: "Next page" }).click({ timeout: CEILING.ui });

        // Observe from the click, not from confirmed reconnection. On a busy
        // page the reconnect poll itself can take longer than sonner's 4 s
        // lifetime, even though the real refusal arrives immediately after
        // the socket reconnects. Starting this bounded observation now makes
        // it impossible for a correct, short-lived answer to disappear in
        // the gap between those two states.
        const refusalToast = refusedWidgetToast(guestB).first();
        const refusalObserved = expect(refusalToast)
          .toBeVisible({ timeout: CEILING.ui })
          .then(async () => {
            // Visual evidence for this package's HANDOFF. Sonner mounts the
            // toast and then animates it in (translateY + opacity). The
            // assertion above is the test; this bounded wait only makes the
            // screenshot legible and never changes the pass/fail result.
            await expect
              .poll(
                () =>
                  refusalToast.evaluate(
                    (element) =>
                      element.getAttribute("data-mounted") === "true" &&
                      Number(getComputedStyle(element).opacity) === 1,
                  ),
                { timeout: 2_000, message: "expected the refusal toast to finish animating in" },
              )
              .toBe(true)
              .catch(() => undefined);
            const screenshotPath = testInfo.outputPath("guestB-refused-page-request-toast.png");
            await guestB.screenshot({ path: screenshotPath });
            await testInfo.attach("guestB-refused-page-request-toast", {
              path: screenshotPath,
              contentType: "image/png",
            });
          });

        await guestBCtx.setOffline(false);
        await Promise.all([waitConnected(guestB, "guestB after reconnect"), refusalObserved]);

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
