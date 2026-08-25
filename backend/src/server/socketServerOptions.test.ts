import { describe, expect, it, vi } from "vitest";
import { createSocketServerOptions } from "./socketServerOptions";

describe("Socket.IO server options", () => {
  it("buffers missed room events briefly and still authenticates recovered connections", () => {
    const options = createSocketServerOptions(() => true, 16 * 1024 * 1024);

    expect(options.connectionStateRecovery).toEqual({
      maxDisconnectionDuration: 120_000,
      skipMiddlewares: false,
    });
  });

  it("keeps origin decisions and the transport byte ceiling in the same options", () => {
    const allowed = vi.fn((origin?: string) => origin === "https://team.example");
    const callback = vi.fn();
    const options = createSocketServerOptions(allowed, 123_456);

    options.cors.origin("https://team.example", callback);
    expect(callback).toHaveBeenCalledWith(null, true);
    expect(options.maxHttpBufferSize).toBe(123_456);
  });
});
