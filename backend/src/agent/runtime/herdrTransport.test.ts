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

const withWatchdog = <T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void) =>
  new Promise<T>((resolve, reject) => {
    const watchdog = setTimeout(() => {
      onTimeout();
      reject(new Error("Transport exceeded the test watchdog."));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(watchdog);
        resolve(value);
      },
      (error) => {
        clearTimeout(watchdog);
        reject(error);
      },
    );
  });

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

  it("applies an absolute request deadline even while the runtime trickles bytes", async () => {
    const deadlineMs = 500;
    let runtimeSocket: net.Socket | null = null;
    const socketPath = await serverAt((socket) => {
      runtimeSocket = socket;
      socket.on("error", () => {});
      const trickle = setInterval(() => socket.write(" "), 100);
      socket.once("close", () => {
        clearInterval(trickle);
      });
    });

    await expect(
      withWatchdog(
        new UnixHerdrTransport(deadlineMs).request(socketPath, "ping", {}),
        deadlineMs * 2,
        () => runtimeSocket?.destroy(),
      ),
    ).rejects.toMatchObject({
      code: "RUNTIME_NOT_CONNECTED",
      message: "Runtime request timed out.",
    });
  });

  it("applies the same absolute deadline while a subscription awaits its acknowledgement", async () => {
    const deadlineMs = 500;
    let runtimeSocket: net.Socket | null = null;
    const socketPath = await serverAt((socket) => {
      runtimeSocket = socket;
      socket.on("error", () => {});
      const trickle = setInterval(() => socket.write(" "), 100);
      socket.once("close", () => {
        clearInterval(trickle);
      });
    });

    await expect(
      withWatchdog(
        new UnixHerdrTransport(deadlineMs).subscribe(socketPath, [], () => {}),
        deadlineMs * 2,
        () => runtimeSocket?.destroy(),
      ),
    ).rejects.toMatchObject({
      code: "RUNTIME_NOT_CONNECTED",
      message: "Runtime subscription timed out.",
    });
  });

  it("keeps an acknowledged subscription alive while no events arrive", async () => {
    const deadlineMs = 40;
    let emitLateEvent!: () => void;
    const socketPath = await serverAt((socket) => {
      socket.once("data", (bytes) => {
        const request = JSON.parse(bytes.toString("utf8"));
        socket.write(
          `${JSON.stringify({ id: request.id, ok: true, result: { type: "subscription_started" } })}\n`,
        );
        emitLateEvent = () => {
          socket.write(
            `${JSON.stringify({ event: "pane.agent_status_changed", data: { agent_status: "done" } })}\n`,
          );
        };
      });
    });
    const transport = new UnixHerdrTransport(deadlineMs);
    let resolveEvent!: (event: Record<string, unknown>) => void;
    const event = new Promise<Record<string, unknown>>((resolve) => {
      resolveEvent = resolve;
    });
    const subscription = await transport.subscribe(socketPath, [], resolveEvent);

    await new Promise((resolve) => setTimeout(resolve, deadlineMs * 2));
    emitLateEvent();
    await expect(event).resolves.toMatchObject({
      event: "pane.agent_status_changed",
      data: { agent_status: "done" },
    });
    subscription.close();
  });
});
