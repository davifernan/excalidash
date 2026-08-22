import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { createDrawing, deleteDrawing, getDrawing, updateDrawing } from "./helpers/api";

type FileBearingEmit = {
  at: number;
  dataLength: number;
  file: Record<string, any>;
  mimeType: string;
};

const COMPRESSION_MIN_DATA_URL_LENGTH = 350_000;
const COMPRESSION_MAX_DIMENSION = 2_800;
const EMIT_QUIET_WINDOW_MS = 6_500;
// One late frame is tolerated after persistence has completed. The regression
// is a repeating poll/socket/save cycle, not a single delivery racing the
// observation boundary.
const MAX_ADDITIONAL_FILE_EMITS = 1;

/**
 * Regression tests for:
 * - Issue #25: pasted image doesn't load in other tabs
 * - Follow-up: deleting the image in one tab should remove it from all tabs
 *
 * NOTE:
 * We drive the editor via Excalidraw's API (exposed in dev/test builds) to make
 * the test deterministic and to specifically model the async "element first,
 * file data later" behavior seen with paste/import.
 */

const openEditorTab = async (context: BrowserContext, drawingId: string) => {
  const page = await context.newPage();
  await page.goto(`/editor/${drawingId}`);
  await page.waitForSelector("[class*='excalidraw'], canvas", { timeout: 15000 });
  await page.waitForFunction(() => {
    return !!(window as any).__EXCALIDASH_EXCALIDRAW_API__;
  });
  await page.waitForFunction(() => {
    return (window as any).__EXCALIDASH_SOCKET_STATUS__?.connected === true;
  });
  return page;
};

const waitForFileInEditor = async (page: Page, fileId: string) => {
  const timeoutMs = 30000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await page.evaluate((id) => {
      const api = (window as any).__EXCALIDASH_EXCALIDRAW_API__;
      const files = api?.getFiles?.() || {};
      const entry = files?.[id];
      return !!entry && typeof entry.mimeType === "string";
    }, fileId);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for file ${fileId} to exist in editor`);
};

const injectImageElementThenFile = async (page: Page) => {
  return await page.evaluate(async () => {
    const api = (window as any).__EXCALIDASH_EXCALIDRAW_API__;
    if (!api) throw new Error("Missing __EXCALIDASH_EXCALIDRAW_API__");

    const bytes = crypto.getRandomValues(new Uint8Array(20));
    const fileId = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const elementId = `img_${Math.random().toString(36).slice(2)}`;

    const dataURL =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAIElEQVR42mP8z8Dwn4EIwDiqgWjAqIGhBo4aGAAAcO0Gg+o1P8oAAAAASUVORK5CYII=";

    const now = Date.now();
    const element = {
      id: elementId,
      type: "image",
      x: 120,
      y: 120,
      width: 240,
      height: 240,
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
      seed: Math.floor(Math.random() * 2 ** 31),
      version: 1,
      versionNonce: Math.floor(Math.random() * 2 ** 31),
      isDeleted: false,
      boundElements: null,
      link: null,
      locked: false,
      index: "a1",
      updated: now,
      status: "pending",
      fileId,
      scale: [1, 1],
      crop: null,
    };

    const before = api.getSceneElementsIncludingDeleted();
    api.updateScene({ elements: [...before, element] });

    await new Promise((r) => setTimeout(r, 600));
    api.addFiles({
      [fileId]: {
        id: fileId,
        mimeType: "image/png",
        dataURL,
        created: Date.now(),
        lastRetrieved: Date.now(),
      },
    });

    return { fileId, elementId };
  });
};

const waitForElementPresent = async (page: Page, elementId: string) => {
  await page.waitForFunction(
    (id) => {
      const api = (window as any).__EXCALIDASH_EXCALIDRAW_API__;
      const els = api?.getSceneElementsIncludingDeleted?.() || [];
      const el = els.find((e: any) => e?.id === id);
      return !!el && el.isDeleted !== true;
    },
    elementId,
    { timeout: 15000 },
  );
};

const waitForElementDeletedEverywhere = async (page: Page, elementId: string) => {
  await page.waitForFunction(
    (id) => {
      const api = (window as any).__EXCALIDASH_EXCALIDRAW_API__;
      const els = api?.getSceneElementsIncludingDeleted?.() || [];
      const el = els.find((e: any) => e?.id === id);
      return !!el && el.isDeleted === true;
    },
    elementId,
    { timeout: 15000 },
  );
};

const getFileRenderState = async (page: Page, fileId: string, elementId: string) =>
  page.evaluate(
    async ({ fileId, elementId }) => {
      const api = (window as any).__EXCALIDASH_EXCALIDRAW_API__;
      const file = api.getFiles()[fileId];
      const element = api
        .getSceneElementsIncludingDeleted()
        .find((candidate: any) => candidate?.id === elementId);
      const decoded = await new Promise<{ width: number; height: number }>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
        image.onerror = () => reject(new Error("Browser could not decode synchronized image"));
        image.src = file.dataURL;
      });
      return {
        dataLength: file.dataURL.length,
        decoded,
        elementFileId: element?.fileId,
        elementStatus: element?.status,
        mimeType: file.mimeType,
      };
    },
    { fileId, elementId },
  );

const injectCompressibleImage = async (page: Page) =>
  page.evaluate(async () => {
    const api = (window as any).__EXCALIDASH_EXCALIDRAW_API__;
    if (!api) throw new Error("Missing __EXCALIDASH_EXCALIDRAW_API__");

    const width = 3_001;
    const height = 160;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Missing 2D canvas context");

    const pixels = context.createImageData(width, height);
    let seed = 0x390328;
    for (let offset = 0; offset < pixels.data.length; offset += 4) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      pixels.data[offset] = seed & 0xff;
      pixels.data[offset + 1] = (seed >>> 8) & 0xff;
      pixels.data[offset + 2] = (seed >>> 16) & 0xff;
      pixels.data[offset + 3] = 0xff;
    }
    context.putImageData(pixels, 0, 0);
    const dataURL = canvas.toDataURL("image/png");
    // Keep the browser-side guard literal because Playwright serializes this
    // callback without module-scope bindings.
    if (dataURL.length <= 350_000) {
      throw new Error(`PNG did not exceed compression threshold: ${dataURL.length}`);
    }

    // Excalidraw derives image file IDs from the original bytes. Keeping that
    // identity stable is what makes compression capable of exposing the loop.
    const binary = atob(dataURL.slice(dataURL.indexOf(",") + 1));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const digest = await crypto.subtle.digest("SHA-1", bytes);
    const fileId = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const elementId = `nil392_${Math.random().toString(36).slice(2)}`;
    const created = Date.now();

    api.addFiles({
      [fileId]: {
        id: fileId,
        mimeType: "image/png",
        dataURL,
        created,
        lastRetrieved: created,
      },
    });
    api.updateScene({
      elements: [
        ...api.getSceneElementsIncludingDeleted(),
        {
          id: elementId,
          type: "image",
          x: 100,
          y: 100,
          width: 600,
          height: 32,
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
          seed: 390328,
          version: 1,
          versionNonce: 390329,
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

    return { dataLength: dataURL.length, elementId, fileId, height, width };
  });

const waitForCompressedPersistence = async (
  request: Parameters<typeof getDrawing>[0],
  drawingId: string,
  fileId: string,
) => {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const drawing = await getDrawing(request, drawingId);
    const file = drawing.files?.[fileId];
    if (file?.mimeType === "image/webp" && typeof file.dataURL === "string") {
      return file;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for compressed file persistence");
};

test.describe("Issue #25 - image sync + deletion across tabs", () => {
  const createdDrawingIds: string[] = [];

  test.afterEach(async ({ request }) => {
    for (const id of createdDrawingIds) {
      try {
        await deleteDrawing(request, id);
      } catch {}
    }
    createdDrawingIds.length = 0;
  });

  test("image added in tab1 appears in tab2 and tab3; deletion propagates to all tabs", async ({
    browser,
    request,
  }) => {
    test.setTimeout(120000);
    const drawing = await createDrawing(request, {
      name: `Issue25_ImageCollab_${Date.now()}`,
      elements: [],
      files: {},
    });
    createdDrawingIds.push(drawing.id);

    const context = await browser.newContext();
    const page1 = await openEditorTab(context, drawing.id);
    const page2 = await openEditorTab(context, drawing.id);

    const { fileId, elementId } = await injectImageElementThenFile(page1);

    await waitForElementPresent(page2, elementId);
    await waitForFileInEditor(page2, fileId);

    const snapshot = await page1.evaluate(() => {
      const api = (window as any).__EXCALIDASH_EXCALIDRAW_API__;
      const elements = api.getSceneElementsIncludingDeleted();
      const files = api.getFiles?.() || {};
      const appState = api.getAppState?.() || {};
      return {
        elements,
        files,
        appState: {
          viewBackgroundColor: appState.viewBackgroundColor ?? "#ffffff",
          gridSize: appState.gridSize ?? null,
        },
      };
    });
    await updateDrawing(request, drawing.id, snapshot);

    const page3 = await openEditorTab(context, drawing.id);
    await waitForFileInEditor(page3, fileId);

    await page2.evaluate((id) => {
      const api = (window as any).__EXCALIDASH_EXCALIDRAW_API__;
      const appState = api.getAppState();
      api.updateScene({
        appState: {
          ...appState,
          selectedElementIds: { ...(appState.selectedElementIds || {}), [id]: true },
        },
      });
    }, elementId);

    await page1.evaluate((id) => {
      const api = (window as any).__EXCALIDASH_EXCALIDRAW_API__;
      const els = api.getSceneElementsIncludingDeleted();
      const target = els.find((e: any) => e?.id === id);
      if (!target) throw new Error("Target element not found");
      const updated = {
        ...target,
        isDeleted: true,
        version: (target.version ?? 0) + 1,
        versionNonce: Math.floor(Math.random() * 2 ** 31),
        updated: Date.now(),
      };
      api.updateScene({ elements: els.map((e: any) => (e.id === id ? updated : e)) });
    }, elementId);

    await waitForElementDeletedEverywhere(page2, elementId);
    await waitForElementDeletedEverywhere(page3, elementId);

    const persisted = await getDrawing(request, drawing.id);
    const persistedFile = persisted.files?.[fileId];
    expect(typeof persistedFile?.dataURL).toBe("string");
    expect((persistedFile?.dataURL || "").length).toBeGreaterThan(0);

    await context.close();
  });

  test("compressible image reaches a peer, persists compressed, and stops emitting", async ({
    browser,
    request,
  }) => {
    test.setTimeout(120_000);
    const drawing = await createDrawing(request, {
      name: `NIL392_ImageCompression_${Date.now()}`,
      elements: [],
      files: {},
    });
    createdDrawingIds.push(drawing.id);

    const context = await browser.newContext();
    const page1 = await context.newPage();
    const cdp = await context.newCDPSession(page1);
    await cdp.send("Network.enable");
    const fileEmitsById = new Map<string, FileBearingEmit[]>();
    cdp.on("Network.webSocketFrameSent", ({ response }: any) => {
      const payload = String(response?.payloadData || "");
      const marker = payload.indexOf('["element-update",');
      if (marker < 0) return;
      try {
        const packet = JSON.parse(payload.slice(marker));
        const files = packet?.[1]?.files;
        if (!files || typeof files !== "object") return;
        for (const [fileId, file] of Object.entries(files)) {
          const record = file as Record<string, any>;
          const events = fileEmitsById.get(fileId) || [];
          events.push({
            at: Date.now(),
            dataLength: typeof record.dataURL === "string" ? record.dataURL.length : 0,
            file: record,
            mimeType: String(record.mimeType || ""),
          });
          fileEmitsById.set(fileId, events);
        }
      } catch {
        // Engine.IO control frames and other non-JSON frames are irrelevant.
      }
    });

    try {
      await page1.goto(`/editor/${drawing.id}`);
      await page1.waitForSelector("[class*='excalidraw'], canvas", { timeout: 15_000 });
      await page1.waitForFunction(() => {
        return (
          !!(window as any).__EXCALIDASH_EXCALIDRAW_API__ &&
          (window as any).__EXCALIDASH_SOCKET_STATUS__?.connected === true
        );
      });
      const page2 = await openEditorTab(context, drawing.id);

      const injected = await injectCompressibleImage(page1);
      expect(injected.width).toBeGreaterThan(COMPRESSION_MAX_DIMENSION);
      expect(injected.dataLength).toBeGreaterThan(COMPRESSION_MIN_DATA_URL_LENGTH);
      expect(injected.fileId).toMatch(/^[0-9a-f]{40}$/);

      await waitForElementPresent(page2, injected.elementId);
      await waitForFileInEditor(page2, injected.fileId);
      const peerState = await getFileRenderState(page2, injected.fileId, injected.elementId);
      expect(peerState.mimeType).toBe("image/png");
      expect(peerState.dataLength).toBe(injected.dataLength);
      expect(peerState.decoded).toEqual({ width: 3_001, height: 160 });
      expect(peerState.elementFileId).toBe(injected.fileId);
      expect(peerState.elementStatus).toBe("saved");

      const persistedFile = await waitForCompressedPersistence(
        request,
        drawing.id,
        injected.fileId,
      );
      expect(persistedFile.dataURL.length).toBeLessThan(injected.dataLength * 0.9);

      const editorAfterCompression = await getFileRenderState(
        page1,
        injected.fileId,
        injected.elementId,
      );
      expect(editorAfterCompression.mimeType).toBe("image/png");
      expect(editorAfterCompression.dataLength).toBe(injected.dataLength);

      await expect
        .poll(() => fileEmitsById.get(injected.fileId)?.length || 0, { timeout: 10_000 })
        .toBeGreaterThan(0);
      const emitsAtWindowStart = fileEmitsById.get(injected.fileId)?.length || 0;
      const firstOutbound = fileEmitsById.get(injected.fileId)?.[0];
      if (!firstOutbound) throw new Error("No outbound file-bearing element-update observed");

      const recalculatedDeltaKeys = await page1.evaluate(
        async ({ baselineFile, fileId }) => {
          const { getFilesDelta } = await import("/src/pages/editor/shared.ts");
          const api = (window as any).__EXCALIDASH_EXCALIDRAW_API__;
          return Object.keys(getFilesDelta({ [fileId]: baselineFile }, api.getFiles?.() || {}));
        },
        { baselineFile: firstOutbound.file, fileId: injected.fileId },
      );
      expect(recalculatedDeltaKeys).toEqual([]);

      await page1.waitForTimeout(EMIT_QUIET_WINDOW_MS);
      const allFileEmits = fileEmitsById.get(injected.fileId) || [];
      const additionalFileEmits = allFileEmits.length - emitsAtWindowStart;
      expect(additionalFileEmits).toBeLessThanOrEqual(MAX_ADDITIONAL_FILE_EMITS);

      await page2.close();
      await page1.reload();
      await page1.waitForFunction(() => Boolean((window as any).__EXCALIDASH_EXCALIDRAW_API__));
      await waitForElementPresent(page1, injected.elementId);
      await waitForFileInEditor(page1, injected.fileId);
      const reloaded = await getFileRenderState(page1, injected.fileId, injected.elementId);
      expect(reloaded.mimeType).toBe("image/webp");
      expect(reloaded.dataLength).toBe(persistedFile.dataURL.length);
      expect(reloaded.decoded.width).toBe(COMPRESSION_MAX_DIMENSION);
      expect(reloaded.decoded.height).toBeGreaterThan(0);
      expect(reloaded.elementFileId).toBe(injected.fileId);
      expect(reloaded.elementStatus).toBe("saved");

      console.log(
        `NIL392_RESULT=${JSON.stringify({
          additionalFileEmits,
          allFileEmits: allFileEmits.map(({ at, dataLength, mimeType }) => ({
            at,
            dataLength,
            mimeType,
          })),
          editorAfterCompression,
          injected,
          peerState,
          persisted: {
            dataLength: persistedFile.dataURL.length,
            mimeType: persistedFile.mimeType,
          },
          quietWindowMs: EMIT_QUIET_WINDOW_MS,
          recalculatedDeltaKeys,
          reloaded,
        })}`,
      );
    } finally {
      await context.close();
    }
  });
});
