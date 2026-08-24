import { expect, test } from "@playwright/test";
import { createDrawing, deleteDrawing } from "./helpers/api";
import {
  injectNoiseImage,
  openEditor,
  peerHasFile,
  scene,
  waitForPeerFile,
} from "./helpers/editor";

const SLOW_UPLOAD_BYTES_PER_SECOND = 1024 * 1024;
const LARGE_ELEMENT_ID = "nil533_large_retry";
const SMALL_ELEMENT_ID = "nil533_small_after_reconnect";

test("a fresh image passes a retrying large image after reconnect", async ({
  browser,
  request,
}, testInfo) => {
  test.setTimeout(150_000);
  const drawing = await createDrawing(request, {
    name: `NIL533_ReconnectImageDelivery_${Date.now()}`,
    elements: [],
    files: {},
  });
  const senderContext = await browser.newContext();
  const peerContext = await browser.newContext();
  const sender = await senderContext.newPage();
  const peer = await peerContext.newPage();
  const network = await senderContext.newCDPSession(sender);
  await network.send("Network.enable");
  const outboundFilePackets: Array<{ at: number; fileIds: string[] }> = [];
  network.on("Network.webSocketFrameSent", ({ response }: any) => {
    const payload = String(response?.payloadData || "");
    const marker = payload.indexOf('["element-update",');
    if (marker < 0) return;
    try {
      const packet = JSON.parse(payload.slice(marker));
      const files = packet?.[1]?.files;
      if (files && typeof files === "object") {
        outboundFilePackets.push({ at: Date.now(), fileIds: Object.keys(files) });
      }
    } catch {
      // Engine.IO control frames and partial payloads are irrelevant.
    }
  });

  try {
    await openEditor(sender, drawing.id);
    await openEditor(peer, drawing.id);
    await sender.waitForFunction(
      () => (window as any).__EXCALIDASH_SOCKET_STATUS__?.connected === true,
      undefined,
      { timeout: 30_000 },
    );
    await peer.waitForFunction(
      () => (window as any).__EXCALIDASH_SOCKET_STATUS__?.connected === true,
      undefined,
      { timeout: 30_000 },
    );

    await network.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 20,
      downloadThroughput: 10 * 1024 * 1024,
      uploadThroughput: SLOW_UPLOAD_BYTES_PER_SECOND,
    });
    const large = await injectNoiseImage(sender, {
      withHash: true,
      targetBytes: 6 * 1024 * 1024,
      elementId: LARGE_ELEMENT_ID,
      position: { x: 100, y: 120 },
    });
    await sender.waitForTimeout(100);
    await sender.evaluate(() => {
      const status = (window as any).__EXCALIDASH_SOCKET_STATUS__;
      if (typeof status?.dropTransport !== "function") {
        throw new Error("Missing Socket.IO transport-drop test control");
      }
      status.dropTransport();
    });
    await sender.waitForFunction(
      () => (window as any).__EXCALIDASH_SOCKET_STATUS__?.connected === false,
      undefined,
      { timeout: 10_000 },
    );

    // Queue the new image before Socket.IO rejoins. The old large attempt
    // may retry forever, but it must no longer own the only delivery slot.
    const smallQueuedAt = Date.now();
    const small = await injectNoiseImage(sender, {
      withHash: true,
      targetBytes: 1 * 1024 * 1024,
      elementId: SMALL_ELEMENT_ID,
      position: { x: 360, y: 120 },
    });
    await sender.waitForFunction(
      () => (window as any).__EXCALIDASH_SOCKET_STATUS__?.connected === true,
      undefined,
      { timeout: 30_000 },
    );
    await sender.waitForFunction(
      () => (window as any).__EXCALIDASH_SOCKET_STATUS__?.roomJoined === true,
      undefined,
      { timeout: 30_000 },
    );
    expect(await waitForPeerFile(peer, small.fileId, 20_000)).toBe(small.dataHash);
    await expect
      .poll(async () => (await scene(peer)).map((element: any) => element.id))
      .toContain(SMALL_ELEMENT_ID);
    const smallArrivedAfterMs = Date.now() - smallQueuedAt;
    expect(outboundFilePackets[1]?.fileIds).toEqual([small.fileId]);
    expect(await peerHasFile(peer, large.fileId)).toBe(false);

    const screenshotPath = testInfo.outputPath("small-image-arrived-before-large-retry.png");
    await peer.screenshot({ path: screenshotPath, fullPage: true });
    await testInfo.attach("small-image-arrived-before-large-retry", {
      path: screenshotPath,
      contentType: "image/png",
    });

    await network.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    expect(await waitForPeerFile(peer, large.fileId, 30_000)).toBe(large.dataHash);
    await expect
      .poll(async () => (await scene(peer)).map((element: any) => element.id))
      .toEqual(expect.arrayContaining([LARGE_ELEMENT_ID, SMALL_ELEMENT_ID]));
    console.log(
      `NIL533_RESULT=${JSON.stringify({
        largeDataURLLength: large.dataURLLength,
        largeFileId: large.fileId,
        smallArrivedAfterMs,
        smallDataURLLength: small.dataURLLength,
        smallFileId: small.fileId,
        uploadBytesPerSecond: SLOW_UPLOAD_BYTES_PER_SECOND,
      })}`,
    );
  } finally {
    await senderContext.close();
    await peerContext.close();
    await deleteDrawing(request, drawing.id);
  }
});
