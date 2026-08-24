import type { Page } from "@playwright/test";

/**
 * The browser-side counterpart to helpers/api.ts.
 *
 * `window.__EXCALIDASH_TEST__` (frontend/src/pages/Editor.tsx) is the one
 * harness a spec is allowed to reach the running editor through -- it goes via
 * the same adapter the product uses, rather than around it. This file is the
 * shared layer above that raw global: `openEditor`, `armTool`, `scene` and
 * friends were each written out three to eight times across specs before this
 * existed. Add to it only what a second spec actually needs, not what a
 * future one might.
 */

const hasHarness = () => !!(window as unknown as Record<string, unknown>).__EXCALIDASH_TEST__;

/** Open a drawing and wait until the harness is live, not just the canvas. */
export const openEditor = async (
  page: Page,
  drawingId: string,
  options?: { settleMs?: number },
): Promise<Page> => {
  await page.goto(`/editor/${drawingId}`);
  await page.waitForSelector("canvas");
  await page.waitForFunction(hasHarness);
  if (options?.settleMs) await page.waitForTimeout(options.settleMs);
  return page;
};

/**
 * The scene, projected to the fields specs actually assert on. Extend this
 * projection rather than reading `getSceneElements()` ad hoc in a spec --
 * one place to keep in sync with the harness's element shape.
 */
export const scene = (page: Page) =>
  page.evaluate(() => {
    const api = (window as unknown as { __EXCALIDASH_TEST__: any }).__EXCALIDASH_TEST__;
    return api.getSceneElements().map((element: any) => ({
      id: element.id,
      type: element.type,
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
      backgroundColor: element.backgroundColor,
      containerId: element.containerId,
      fontSize: element.fontSize,
      text: element.text,
      sticky: element.customData?.excalidash?.sticky ?? null,
      schemaVersion: element.customData?.excalidash?.schemaVersion ?? null,
    }));
  });

export const notes = async (page: Page) => (await scene(page)).filter((e: any) => e.sticky);
export const labels = async (page: Page) => (await scene(page)).filter((e: any) => e.containerId);

/** A button registered through `ui.toolbarSlot()`, by its own tool name. */
export const toolbarButton = (page: Page, name: string) => page.getByTestId(`toolbar-${name}`);

/**
 * Drop a text/markdown file onto the canvas, the way a real drag from the
 * desktop does. Shared with team-acceptance.spec.ts (NIL-330), which needs
 * the same paginated document widget document-pages.spec.ts builds.
 */
export const dropMarkdown = async (page: Page, source: string, name = "notes.md") => {
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

/**
 * A noise-filled PNG of a target raw byte size, injected as an image element
 * via the same `addFiles`/`updateScene` path the product uses. Shared by
 * team-acceptance.spec.ts and team-readiness.spec.ts (NIL-330) -- both need
 * the same pixel generation and scene-injection shape, one to verify content
 * hashes arrive on a peer unchanged and the other purely as sustained size
 * pressure with no peer to check.
 *
 * Random pixels are incompressible, so the encoded PNG lands close to
 * `targetBytes` regardless of what the browser's deflate pass does.
 * `crypto.getRandomValues` fills the pixel buffer in 64KiB chunks (its own
 * per-call cap) rather than a JS-level per-pixel loop, which matters once
 * `targetBytes` reaches double digits of MB.
 *
 * `withHash: true` (team-acceptance's peer-verification use) derives the
 * file id from a SHA-1 of the raw bytes and returns a SHA-256 `dataHash` a
 * peer's own received copy can be compared against -- computed in-browser
 * deliberately, so a multi-MB data URL never crosses the Playwright RPC
 * boundary just to be hashed in Node. Without it (team-readiness's pressure-
 * only use), `elementId` doubles as the file id and no hash is computed.
 *
 * `peerFile` is the receiving side of the same contract: the file as the
 * peer's editor holds it, decoded the same native way.
 */
export const injectNoiseImage = (
  page: Page,
  {
    targetBytes,
    elementId,
    position,
    withHash = false,
  }: {
    targetBytes: number;
    elementId: string;
    position?: { x: number; y: number };
    withHash?: boolean;
  },
): Promise<{
  fileId: string;
  dataURLLength: number;
  dataHash?: string;
  width: number;
  height: number;
}> =>
  page.evaluate(
    async ({ targetBytes, elementId, position, withHash }) => {
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
        crypto.getRandomValues(
          pixels.data.subarray(offset, Math.min(offset + CHUNK, pixels.data.length)),
        );
      }
      context.putImageData(pixels, 0, 0);
      const dataURL = canvas.toDataURL("image/png");

      let fileId = elementId;
      let dataHash: string | undefined;
      if (withHash) {
        // `fetch` decodes the data URL natively. The previous `atob` +
        // `Uint8Array.from(binary, c => c.charCodeAt(0))` was a JavaScript
        // loop over every byte -- twenty million iterations for the 20 MB
        // case, on the page's main thread, with three peers doing the same.
        // On a shared CI runner that froze the page for longer than some of
        // the spec's own waits (NIL-546's `navigator.onLine` poll timed out
        // against exactly this).
        const bytes = await (await fetch(dataURL)).arrayBuffer();
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        dataHash = Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
        const fileDigest = await crypto.subtle.digest("SHA-1", bytes);
        fileId = Array.from(new Uint8Array(fileDigest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
      }

      const created = Date.now();
      const api = (window as any).__EXCALIDASH_TEST__;
      if (!api) throw new Error("Missing __EXCALIDASH_TEST__");
      api.addFiles({
        [fileId]: { id: fileId, mimeType: "image/png", dataURL, created, lastRetrieved: created },
      });
      api.updateScene({
        elements: [
          ...api.getSceneElementsIncludingDeleted(),
          {
            id: elementId,
            type: "image",
            x: position?.x ?? 40,
            y: position?.y ?? 100,
            width: position ? 100 : 120,
            height: position ? 80 : 90,
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
            index: `nil330_${Date.now()}_${Math.random().toString(36).slice(2)}`,
            updated: created,
            status: "saved",
            fileId,
            scale: [1, 1],
            crop: null,
          },
        ],
      });
      return { fileId, dataURLLength: dataURL.length, dataHash, width, height };
    },
    { targetBytes, elementId, position, withHash },
  );

/** Wait for a peer's editor to receive one file and return its SHA-256 content hash. */
export const waitForPeerFile = async (page: Page, fileId: string, timeout = 30_000) => {
  await page.waitForFunction(
    (id) => Boolean((window as any).__EXCALIDASH_TEST__?.getFiles?.()?.[id]),
    fileId,
    { timeout },
  );
  return page.evaluate(async (id) => {
    const dataURL = (window as any).__EXCALIDASH_TEST__.getFiles()[id].dataURL;
    const binary = atob(dataURL.slice(dataURL.indexOf(",") + 1));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  }, fileId);
};

export const peerHasFile = (page: Page, fileId: string) =>
  page.evaluate((id) => Boolean((window as any).__EXCALIDASH_TEST__?.getFiles?.()?.[id]), fileId);

/**
 * A file as a peer's editor holds it, resolved the way the editor would
 * render it.
 *
 * Since NIL-381 a board image has two legitimate shapes on a peer. Delivered
 * live over the socket it is the sender's inline `data:` URL, byte for byte.
 * Once the peer has rebased its scene from the server (any 409 on its own
 * autosave does that), the same file id carries the blob store's URL
 * (`/api/files/<drawing>/<file>`) instead, and the store serves a lossy
 * WebP re-encode -- deliberately, that is what keeps the scene JSON small.
 * "Hash-identical on every peer" was the contract when this helper's
 * callers were written and is no longer one the product makes; a spec that
 * asserts it goes red or green depending on whether a rebase happened to
 * land before its check. `source` tells the caller which shape it got, so
 * it can assert byte identity for `inline` and image identity (it decodes,
 * and its dimensions are the original's) for `store`.
 */
export type PeerFile = {
  source: "inline" | "store";
  hash: string;
  width: number;
  height: number;
  byteLength: number;
};

export const peerFile = (page: Page, fileId: string): Promise<PeerFile | null> =>
  page.evaluate(async (id) => {
    const file = (window as any).__EXCALIDASH_TEST__?.getFiles?.()?.[id];
    const dataURL: unknown = file?.dataURL;
    if (typeof dataURL !== "string" || dataURL.length === 0) return null;
    const source = dataURL.startsWith("data:") ? "inline" : "store";
    // Anything that is not yet a complete image reads as "not there yet",
    // never as a throw: a store copy can be served while its WebP is still
    // being written, and `createImageBitmap` rejects (InvalidStateError)
    // rather than returning null on bytes it cannot decode. A throw here
    // would end the caller's `expect.poll` on the spot instead of letting it
    // wait out its ceiling -- the poll only retries on a falsy value.
    try {
      const response = await fetch(dataURL, { credentials: "include" });
      if (!response.ok) return null;
      const blob = await response.blob();
      const bytes = await blob.arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const hash = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      const bitmap = await createImageBitmap(blob);
      const { width, height } = bitmap;
      bitmap.close();
      return { source, hash, width, height, byteLength: bytes.byteLength };
    } catch {
      return null;
    }
  }, fileId);

/**
 * `__EXCALIDASH_TEST__.getDeliveryState()`, typed. What the sending peer's
 * outbound queue is doing; see useEditorBroadcast.ts's `DeliveryState`.
 */
export type DeliveryState = {
  inFlight: boolean;
  parked: boolean;
  retrying: boolean;
  acknowledgedFileIds: readonly string[];
  rejectedFileIds: readonly string[];
};

export const deliveryState = (page: Page): Promise<DeliveryState | null> =>
  page.evaluate(() => (window as any).__EXCALIDASH_TEST__?.getDeliveryState?.() ?? null);

export const documentPageLabel = (page: Page) => page.locator(".text-document-widget__page-number");

/**
 * Excalidraw keeps an embedded element behind its own canvas until you click
 * it, the same way it guards an embedded video. Until then the canvas swallows
 * every click, so the widget's own controls cannot be reached.
 */
export const activateDocumentWidget = async (page: Page) => {
  const box = await page.locator(".text-document-widget").boundingBox();
  if (!box) throw new Error("The document widget is not on the board.");
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(300);
};

/** Arm the sticky-note tool and wait for the editor to confirm it, not just the click. */
export const armTool = async (page: Page) => {
  await toolbarButton(page, "sticky").click();
  await page.waitForFunction(
    () =>
      (window as unknown as { __EXCALIDASH_TEST__: any }).__EXCALIDASH_TEST__.getAppState()
        .activeTool?.customType === "sticky",
  );
};
