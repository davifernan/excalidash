import fs from "fs/promises";
import net from "net";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { UnixHerdrTransport } from "./herdrTransport";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const serverAt = async (handler: (socket: net.Socket) => void) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "exd-herdr-"));
  const socketPath = path.join(directory, "herdr.sock");
  const server = net.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => void fs.rm(directory, { recursive: true, force: true }).then(resolve));
      }),
  );
  return socketPath;
};

describe("Herdr Unix socket transport", () => {
  it("sends one newline-delimited request and accepts one bounded response", async () => {
    const socketPath = await serverAt((socket) => {
      socket.once("data", (bytes) => {
        const request = JSON.parse(bytes.toString("utf8"));
        expect(request).toMatchObject({ method: "ping", params: {} });
        socket.end(`${JSON.stringify({ id: request.id, ok: true, result: { type: "pong" } })}\n`);
      });
    });
    await expect(new UnixHerdrTransport().request(socketPath, "ping", {})).resolves.toEqual({
      type: "pong",
    });
  });

  it("keeps a subscription open after its acknowledgement and closes explicitly", async () => {
    let serverSocket: net.Socket | null = null;
    const socketPath = await serverAt((socket) => {
      serverSocket = socket;
      socket.once("data", (bytes) => {
        const request = JSON.parse(bytes.toString("utf8"));
        socket.write(
          `${JSON.stringify({ id: request.id, ok: true, result: { type: "subscription_started" } })}\n`,
        );
        socket.write(
          `${JSON.stringify({ event: "pane.agent_status_changed", data: { pane_id: "w1:p1", agent_status: "idle" } })}\n`,
        );
      });
    });
    const event = new Promise<Record<string, unknown>>((resolve) => {
      void new UnixHerdrTransport()
        .subscribe(socketPath, [{ type: "pane.agent_status_changed", pane_id: "w1:p1" }], resolve)
        .then((subscription) => subscription.close());
    });
    await expect(event).resolves.toMatchObject({ event: "pane.agent_status_changed" });
    expect(serverSocket).not.toBeNull();
  });
});
