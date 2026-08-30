import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeDaemon } from "./daemon";

describe("outbound runtime daemon connection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("opens a newly fenced session after a transient connection loss", async () => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), "nil706-daemon-"));
    const controller = new AbortController();
    const requests: string[] = [];
    let sessionCount = 0;
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        requests.push(url);
        if (url.endsWith("/session")) {
          sessionCount += 1;
          if (sessionCount === 2) controller.abort();
          return new Response(JSON.stringify({ epoch: sessionCount }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error("simulated network loss with secret LEAKME42");
      }),
    );
    const daemon = new RuntimeDaemon(
      {
        serverUrl: "https://board.example",
        credential: "device-secret",
        daemonId: "daemon-1",
        version: "0.16.0",
        profiles: [],
      },
      stateDirectory,
      async () => undefined,
    );

    await daemon.run(controller.signal);

    expect(sessionCount).toBe(2);
    expect(requests.filter((url) => url.endsWith("/session"))).toHaveLength(2);
    expect(process.stderr.write).toHaveBeenCalledWith("Runtime connection lost; retrying.\n");
    expect(JSON.stringify((process.stderr.write as any).mock.calls)).not.toContain("LEAKME42");
    await rm(stateDirectory, { recursive: true });
  });

  it("starts one assignment once across a lost acknowledgement and daemon restart", async () => {
    const stateDirectory = await mkdtemp(path.join(tmpdir(), "nil706-dedup-"));
    const assignmentId = "assignment-one";
    const commands = [
      {
        protocolVersion: 1,
        commandId: "11111111-1111-4111-8111-111111111111",
        kind: "start",
        payload: {
          assignmentId,
          profileId: "codex",
          displayName: "Board agent",
          runId: "run-one",
          drawingId: "drawing-one",
        },
      },
      {
        protocolVersion: 1,
        commandId: "22222222-2222-4222-8222-222222222222",
        kind: "start",
        payload: {
          assignmentId,
          profileId: "codex",
          displayName: "Board agent",
          runId: "run-one",
          drawingId: "drawing-one",
        },
      },
    ] as const;
    const start = vi.fn(async () => {
      expect(
        await readFile(path.join(stateDirectory, "assignment-journal.json"), "utf8"),
      ).toContain(assignmentId);
      return {
        ok: true as const,
        runtimeHandle: "codex-thread-one",
        status: "working" as const,
      };
    });
    const executor = {
      start,
      prompt: vi.fn(),
      status: vi.fn(),
      stopAll: vi.fn(),
    };
    const config = {
      serverUrl: "https://board.example",
      credential: "device-secret",
      daemonId: "daemon-one",
      version: "0.16.0",
      profiles: [],
    };
    const results: unknown[] = [];

    for (let runIndex = 0; runIndex < commands.length; runIndex += 1) {
      const controller = new AbortController();
      let delivered = false;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input);
          if (url.endsWith("/session")) {
            return new Response(JSON.stringify({ epoch: runIndex + 1 }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          if (url.endsWith("/commands/next")) {
            if (delivered) throw new Error("unexpected second poll");
            delivered = true;
            return new Response(JSON.stringify({ command: commands[runIndex] }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          if (url.endsWith("/events")) {
            results.push(JSON.parse(String(init?.body)));
            controller.abort();
            if (runIndex === 0) throw new Error("acknowledgement lost");
            return new Response(JSON.stringify({ accepted: true }), {
              status: 202,
              headers: { "content-type": "application/json" },
            });
          }
          throw new Error(`unexpected request ${url}`);
        }),
      );
      const daemon = new RuntimeDaemon(config, stateDirectory, async () => undefined, executor);
      await daemon.run(controller.signal);
    }

    expect(start).toHaveBeenCalledOnce();
    expect(results).toHaveLength(2);
    expect(results[1]).toMatchObject({
      commandId: commands[1].commandId,
      result: { ok: false, code: "REQUEST_FAILED" },
    });
    const journalPath = path.join(stateDirectory, "assignment-journal.json");
    expect(await readFile(journalPath, "utf8")).toContain(assignmentId);
    expect((await stat(journalPath)).mode & 0o777).toBe(0o600);
    expect((await stat(stateDirectory)).mode & 0o777).toBe(0o700);
    await rm(stateDirectory, { recursive: true });
  });
});
