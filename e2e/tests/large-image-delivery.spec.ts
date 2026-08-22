import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createDrawing, deleteDrawing } from "./helpers/api";

type InjectedImage = {
  dataHash: string;
  dataLength: number;
  elementId: string;
  fileId: string;
};

const openEditor = async (context: BrowserContext, drawingId: string) => {
  const page = await context.newPage();
  await page.goto(`/editor/${drawingId}`);
  await page.waitForFunction(
    () =>
      !!(window as any).__EXCALIDASH_EXCALIDRAW_API__ &&
      (window as any).__EXCALIDASH_SOCKET_STATUS__?.connected === true,
    undefined,
    { timeout: 30_000 },
  );
  return page;
};

const injectLargeImageBatch = async (page: Page): Promise<InjectedImage[]> =>
  page.evaluate(async () => {
    const api = (window as any).__EXCALIDASH_EXCALIDRAW_API__;
    if (!api) throw new Error("Missing __EXCALIDASH_EXCALIDRAW_API__");

    const files: Record<string, any> = {};
    const elements: any[] = [];
    const injected: InjectedImage[] = [];
    for (let imageIndex = 0; imageIndex < 3; imageIndex += 1) {
      const width = 1_400 + imageIndex;
      const height = 900;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Missing 2D canvas context");
      const pixels = context.createImageData(width, height);
      let seed = 0x315000 + imageIndex;
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
      if (dataURL.length < 5 * 1024 * 1024 || dataURL.length > 10 * 1024 * 1024) {
        throw new Error(`Generated image outside the intended boundary: ${dataURL.length}`);
      }

      const binary = atob(dataURL.slice(dataURL.indexOf(",") + 1));
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      const fileDigest = await crypto.subtle.digest("SHA-1", bytes);
      const fileId = Array.from(new Uint8Array(fileDigest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      const dataDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(dataURL));
      const dataHash = Array.from(new Uint8Array(dataDigest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      const elementId = `nil315_${imageIndex}_${Math.random().toString(36).slice(2)}`;
      const created = Date.now();
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
        x: 40 + imageIndex * 320,
        y: 100,
        width: 280,
        height: 180,
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
        seed: 315_000 + imageIndex,
        version: 1,
        versionNonce: 316_000 + imageIndex,
        isDeleted: false,
        boundElements: null,
        link: null,
        locked: false,
        index: `a${imageIndex + 1}`,
        updated: created,
        status: "saved",
        fileId,
        scale: [1, 1],
        crop: null,
      });
      injected.push({ dataHash, dataLength: dataURL.length, elementId, fileId });
    }

    api.addFiles(files);
    api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), ...elements] });
    return injected;
  });

const waitForPeerImage = async (page: Page, image: InjectedImage) => {
  await page.waitForFunction(
    ({ elementId, fileId }) => {
      const api = (window as any).__EXCALIDASH_EXCALIDRAW_API__;
      const file = api?.getFiles?.()?.[fileId];
      const element = api
        ?.getSceneElementsIncludingDeleted?.()
        ?.find((candidate: any) => candidate?.id === elementId && candidate.isDeleted !== true);
      return Boolean(file && element);
    },
    { elementId: image.elementId, fileId: image.fileId },
    { timeout: 30_000 },
  );
  return page.evaluate(async (fileId) => {
    const dataURL = (window as any).__EXCALIDASH_EXCALIDRAW_API__.getFiles()[fileId].dataURL;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(dataURL));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  }, image.fileId);
};

test("three large images arrive in acknowledged packets without disconnecting", async ({
  browser,
  request,
}, testInfo) => {
  test.setTimeout(180_000);
  const drawing = await createDrawing(request, {
    name: `NIL315_LargeImageCollab_${Date.now()}`,
    elements: [],
    files: {},
  });
  const context = await browser.newContext();
  const page1 = await context.newPage();
  const cdp = await context.newCDPSession(page1);
  await cdp.send("Network.enable");
  const outboundFilePackets: Array<{ bytes: number; fileIds: string[] }> = [];
  cdp.on("Network.webSocketFrameSent", ({ response }: any) => {
    const payload = String(response?.payloadData || "");
    const marker = payload.indexOf('["element-update",');
    if (marker < 0) return;
    try {
      const packet = JSON.parse(payload.slice(marker));
      const files = packet?.[1]?.files;
      if (!files || typeof files !== "object") return;
      outboundFilePackets.push({
        bytes: new TextEncoder().encode(JSON.stringify(packet[1])).byteLength,
        fileIds: Object.keys(files),
      });
    } catch {
      // Engine.IO control frames and other non-JSON frames are irrelevant.
    }
  });

  try {
    await page1.goto(`/editor/${drawing.id}`);
    await page1.waitForFunction(
      () =>
        !!(window as any).__EXCALIDASH_EXCALIDRAW_API__ &&
        (window as any).__EXCALIDASH_SOCKET_STATUS__?.connected === true,
      undefined,
      { timeout: 30_000 },
    );
    const page2 = await openEditor(context, drawing.id);
    const injected = await injectLargeImageBatch(page1);

    for (const image of injected) {
      expect(await waitForPeerImage(page2, image)).toBe(image.dataHash);
    }
    await expect
      .poll(() => new Set(outboundFilePackets.flatMap((packet) => packet.fileIds)).size, {
        timeout: 30_000,
      })
      .toBe(3);

    expect(outboundFilePackets.every((packet) => packet.fileIds.length === 1)).toBe(true);
    expect([...new Set(outboundFilePackets.flatMap((packet) => packet.fileIds))].sort()).toEqual(
      injected.map((image) => image.fileId).sort(),
    );
    expect(Math.max(...outboundFilePackets.map((packet) => packet.bytes))).toBeLessThanOrEqual(
      11 * 1024 * 1024,
    );
    expect(await page1.evaluate(() => (window as any).__EXCALIDASH_SOCKET_STATUS__)).toEqual({
      connected: true,
    });

    const screenshotPath = testInfo.outputPath("large-images-peer.png");
    await page2.screenshot({ path: screenshotPath, fullPage: true });
    await testInfo.attach("large-images-peer", { path: screenshotPath, contentType: "image/png" });
    console.log(
      `NIL315_RESULT=${JSON.stringify({
        images: injected.map(({ dataHash, dataLength, fileId }) => ({
          dataHash,
          dataLength,
          fileId,
        })),
        outboundFilePackets,
        socketConnected: true,
      })}`,
    );
  } finally {
    await context.close();
    await deleteDrawing(request, drawing.id);
  }
});
