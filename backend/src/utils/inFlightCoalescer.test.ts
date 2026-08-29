import { describe, expect, it, vi } from "vitest";
import { createInFlightCoalescer } from "./inFlightCoalescer";

describe("createInFlightCoalescer", () => {
  it("shares one operation across concurrent callers for the same key", async () => {
    const coalescer = createInFlightCoalescer<number>();
    const start = vi.fn(() => Promise.resolve(1));

    const [a, b, c] = await Promise.all([
      coalescer.run("key", start),
      coalescer.run("key", start),
      coalescer.run("key", start),
    ]);

    expect(start).toHaveBeenCalledTimes(1);
    expect([a, b, c]).toEqual([1, 1, 1]);
  });

  it("starts a fresh operation once the previous one has settled", async () => {
    const coalescer = createInFlightCoalescer<number>();
    const start = vi.fn(() => Promise.resolve(1));

    await coalescer.run("key", start);
    await coalescer.run("key", start);

    expect(start).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failure", async () => {
    const coalescer = createInFlightCoalescer<number>();
    const start = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(42);

    await expect(coalescer.run("key", start)).rejects.toThrow("boom");
    await expect(coalescer.run("key", start)).resolves.toBe(42);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("keeps different keys independent", async () => {
    const coalescer = createInFlightCoalescer<string>();
    const startA = vi.fn(() => Promise.resolve("a"));
    const startB = vi.fn(() => Promise.resolve("b"));

    const [a, b] = await Promise.all([coalescer.run("a", startA), coalescer.run("b", startB)]);

    expect(a).toBe("a");
    expect(b).toBe("b");
    expect(startA).toHaveBeenCalledTimes(1);
    expect(startB).toHaveBeenCalledTimes(1);
  });

  it("normalizes a synchronous throw from start() into a rejection, and does not cache it", async () => {
    const coalescer = createInFlightCoalescer<number>();
    const start = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("synchronous guard failure");
      })
      .mockResolvedValueOnce(7);

    await expect(coalescer.run("key", start)).rejects.toThrow("synchronous guard failure");
    await expect(coalescer.run("key", start)).resolves.toBe(7);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("reports has() true only while a key is in flight", async () => {
    const coalescer = createInFlightCoalescer<number>();
    expect(coalescer.has("key")).toBe(false);

    let resolveWork: (value: number) => void = () => undefined;
    const run = coalescer.run(
      "key",
      () => new Promise<number>((resolve) => (resolveWork = resolve)),
    );
    expect(coalescer.has("key")).toBe(true);

    resolveWork(1);
    await run;
    expect(coalescer.has("key")).toBe(false);
  });
});
