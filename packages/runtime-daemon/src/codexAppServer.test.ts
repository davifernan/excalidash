import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { CodexAppServerExecutor } from "./codexAppServer";

class FakeCodexProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  methods: string[] = [];

  constructor() {
    super();
    this.stdin.on("data", (chunk) => {
      for (const line of chunk.toString("utf8").trim().split("\n")) {
        const message = JSON.parse(line);
        if (typeof message.method === "string") this.methods.push(message.method);
        if (typeof message.id !== "number") continue;
        const result =
          message.method === "thread/start"
            ? { thread: { id: "codex-thread-1" } }
            : message.method === "turn/start"
              ? { turn: { id: "turn-1" } }
              : {};
        queueMicrotask(() => this.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`));
      }
    });
  }

  kill() {
    this.killed = true;
    return true;
  }
}

describe("Codex CLI app-server executor", () => {
  it("keeps Codex protocol and local credentials behind the daemon boundary", async () => {
    const child = new FakeCodexProcess();
    const spawn = vi.fn(() => child as any);
    const statuses: unknown[] = [];
    const executor = new CodexAppServerExecutor(
      [{ id: "review", label: "Review", workingDirectory: "/workspace" }],
      async (event) => {
        statuses.push(event);
      },
      "https://board.example",
      spawn,
    );
    const result = await executor.start({
      profileId: "review",
      displayName: "Board agent",
      initialPrompt: "Read the approved contexts",
      runId: "run-1",
      drawingId: "drawing-1",
      boardMount: {
        revisionId: "revision-1",
        capabilityToken: "mount-secret",
        allowedContextIds: ["context-1"],
      },
    });
    expect(result).toEqual({
      ok: true,
      runtimeHandle: "codex-thread-1",
      status: "working",
      displayName: "Board agent",
    });
    expect(child.methods).toEqual(["initialize", "initialized", "thread/start", "turn/start"]);
    expect(spawn).toHaveBeenCalledWith(
      "codex",
      ["app-server"],
      expect.objectContaining({
        cwd: "/workspace",
        env: expect.objectContaining({
          EXCALIDASH_API_URL: "https://board.example/api",
          EXCALIDASH_MOUNT_TOKEN: "mount-secret",
        }),
      }),
    );

    child.stdout.write(
      `${JSON.stringify({
        method: "turn/completed",
        params: { turn: { status: "completed" } },
      })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(statuses).toContainEqual({
      runtimeHandle: "codex-thread-1",
      status: "done",
      displayName: "Board agent",
    });
  });

  it("fails closed when an advertised profile has no local executor", async () => {
    const executor = new CodexAppServerExecutor([], async () => undefined, "https://board.example");
    await expect(
      executor.start({
        profileId: "missing",
        displayName: "Agent",
        runId: "run-1",
        drawingId: "drawing-1",
      }),
    ).resolves.toEqual({ ok: false, code: "PROFILE_NOT_FOUND" });
  });

  it("stops local paid work when its server-authoritative daemon session ends", async () => {
    const child = new FakeCodexProcess();
    const executor = new CodexAppServerExecutor(
      [{ id: "review", label: "Review", workingDirectory: "/workspace" }],
      async () => undefined,
      "https://board.example",
      () => child as any,
    );
    const result = await executor.start({
      profileId: "review",
      displayName: "Board agent",
      runId: "run-1",
      drawingId: "drawing-1",
    });
    expect(result.ok).toBe(true);

    executor.stopAll();

    expect(child.killed).toBe(true);
    expect(executor.status("codex-thread-1")).toEqual({
      ok: false,
      code: "REQUEST_FAILED",
    });
  });

  it("bounds a silent app-server with an absolute request deadline", async () => {
    const child = new FakeCodexProcess();
    child.stdin.removeAllListeners("data");
    const executor = new CodexAppServerExecutor(
      [{ id: "review", label: "Review", workingDirectory: "/workspace" }],
      async () => undefined,
      "https://board.example",
      () => child as any,
      10,
    );

    await expect(
      executor.start({
        profileId: "review",
        displayName: "Board agent",
        runId: "run-1",
        drawingId: "drawing-1",
      }),
    ).resolves.toEqual({ ok: false, code: "EXECUTOR_REJECTED" });
    expect(child.killed).toBe(true);
  });
});
