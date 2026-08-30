import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeDaemon } from "./daemon";

describe("outbound runtime daemon connection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
});
