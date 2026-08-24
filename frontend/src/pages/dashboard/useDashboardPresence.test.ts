import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { guestCountFor, presenceKeysFor, useDashboardPresence } from "./useDashboardPresence";

const getDashboardPresence = vi.fn();

vi.mock("../../api", () => ({
  getDashboardPresence: (...args: unknown[]) => getDashboardPresence(...args),
}));

describe("useDashboardPresence", () => {
  beforeEach(() => {
    getDashboardPresence.mockReset();
    getDashboardPresence.mockResolvedValue([
      { drawingId: "d1", connectedMemberKeys: ["k1"], guestCount: 1 },
    ]);
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports who is connected, per board", async () => {
    const { result } = renderHook(() => useDashboardPresence(["d1"]));

    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current!.get("d1")!.keys.has("k1")).toBe(true);
    expect(result.current!.get("d1")!.guestCount).toBe(1);
  });

  it("keeps asking while the page is open", async () => {
    renderHook(() => useDashboardPresence(["d1"]));
    await waitFor(() => expect(getDashboardPresence).toHaveBeenCalledTimes(1));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(getDashboardPresence).toHaveBeenCalledTimes(2);
  });

  it("asks about no more boards than the server accepts", async () => {
    const ids = Array.from({ length: 80 }, (_, index) => `d${index}`);
    renderHook(() => useDashboardPresence(ids));

    await waitFor(() => expect(getDashboardPresence).toHaveBeenCalled());
    expect(getDashboardPresence.mock.calls[0][0]).toHaveLength(50);
  });

  it("leaves the last answer standing when a poll fails", async () => {
    const { result } = renderHook(() => useDashboardPresence(["d1"]));
    await waitFor(() => expect(result.current).not.toBeNull());

    getDashboardPresence.mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(result.current!.get("d1")!.keys.has("k1")).toBe(true);
  });

  it("says nothing at all rather than something stale when the list empties", async () => {
    const { result, rerender } = renderHook(({ ids }) => useDashboardPresence(ids), {
      initialProps: { ids: ["d1"] },
    });
    await waitFor(() => expect(result.current).not.toBeNull());

    rerender({ ids: [] });

    expect(result.current).toBeNull();
  });

  it("warns once when the board list is truncated, not at all when it isn't", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ids = Array.from({ length: 80 }, (_, index) => `d${index}`);
    const { rerender } = renderHook(({ ids }) => useDashboardPresence(ids), {
      initialProps: { ids: ["d1"] },
    });
    await waitFor(() => expect(getDashboardPresence).toHaveBeenCalledTimes(1));
    expect(warn).not.toHaveBeenCalled();

    rerender({ ids });
    await waitFor(() => expect(getDashboardPresence).toHaveBeenCalledTimes(2));
    expect(warn).toHaveBeenCalledTimes(1);

    // A later poll for the same still-truncated list must not warn again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(warn).toHaveBeenCalledTimes(1);

    warn.mockRestore();
  });
});

describe("presenceKeysFor", () => {
  it("returns null while presence hasn't loaded at all", () => {
    expect(presenceKeysFor(null, "d1")).toBeNull();
  });

  it("returns the board's keys once presence has loaded", () => {
    const presence = new Map([["d1", { keys: new Set(["k1"]), guestCount: 0 }]]);
    expect(presenceKeysFor(presence, "d1")).toEqual(new Set(["k1"]));
  });

  it("returns null -- not an empty set -- for a board past the watch limit", () => {
    // Presence loaded (the map is non-null), but this board was never asked
    // about because the dashboard watches at most MAX_WATCHED boards. An
    // empty set here would read as "confirmed nobody online" instead of
    // "unknown" -- the silent-cutoff bug from NIL-305.
    const presence = new Map([["d1", { keys: new Set(["k1"]), guestCount: 0 }]]);
    expect(presenceKeysFor(presence, "d51-beyond-the-cutoff")).toBeNull();
  });
});

describe("guestCountFor", () => {
  it("returns null while presence hasn't loaded at all", () => {
    expect(guestCountFor(null, "d1")).toBeNull();
  });

  it("returns the board's guest count once presence has loaded", () => {
    const presence = new Map([["d1", { keys: new Set<string>(), guestCount: 3 }]]);
    expect(guestCountFor(presence, "d1")).toBe(3);
  });

  it("returns null -- not zero -- for a board past the watch limit", () => {
    // Same distinction as presenceKeysFor: an unwatched board must not read as
    // "confirmed zero guests" (Hans-Friedrich review on PR #72, NIL-305).
    const presence = new Map([["d1", { keys: new Set<string>(), guestCount: 0 }]]);
    expect(guestCountFor(presence, "d51-beyond-the-cutoff")).toBeNull();
  });
});
