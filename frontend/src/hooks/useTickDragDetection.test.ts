import { renderHook, act } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useTickDragDetection } from "./useTickDragDetection";

describe("useTickDragDetection", () => {
  it("returns null on the first tick -- there is no baseline yet", () => {
    const { result } = renderHook(() => useTickDragDetection());
    let tick;
    act(() => {
      tick = result.current.detect([{ id: "a", x: 0, y: 0 }], "a");
    });
    expect(tick).toBeNull();
  });

  it("detects a single moved id that matches the sole selection", () => {
    const { result } = renderHook(() => useTickDragDetection());
    act(() => {
      result.current.detect([{ id: "a", x: 0, y: 0 }], "a");
    });
    let tick;
    act(() => {
      tick = result.current.detect([{ id: "a", x: 10, y: 5 }], "a");
    });
    expect(tick).toEqual({ activeId: "a", before: { x: 0, y: 0 }, after: { x: 10, y: 5 } });
  });

  it("returns null if the moved id is not the sole selection", () => {
    const { result } = renderHook(() => useTickDragDetection());
    act(() => {
      result.current.detect([{ id: "a", x: 0, y: 0 }], "b");
    });
    let tick;
    act(() => {
      tick = result.current.detect([{ id: "a", x: 10, y: 5 }], "b");
    });
    expect(tick).toBeNull();
  });

  it("returns null if the moved id is not selected at all (soleSelectedId null)", () => {
    const { result } = renderHook(() => useTickDragDetection());
    act(() => {
      result.current.detect([{ id: "a", x: 0, y: 0 }], null);
    });
    let tick;
    act(() => {
      tick = result.current.detect([{ id: "a", x: 10, y: 5 }], null);
    });
    expect(tick).toBeNull();
  });

  it("returns null if more than one id moved this tick, even if one matches the selection", () => {
    const { result } = renderHook(() => useTickDragDetection());
    act(() => {
      result.current.detect(
        [
          { id: "a", x: 0, y: 0 },
          { id: "b", x: 0, y: 0 },
        ],
        "a",
      );
    });
    let tick;
    act(() => {
      tick = result.current.detect(
        [
          { id: "a", x: 10, y: 0 },
          { id: "b", x: 0, y: 10 },
        ],
        "a",
      );
    });
    expect(tick).toBeNull();
  });

  it("returns null if nothing moved this tick", () => {
    const { result } = renderHook(() => useTickDragDetection());
    act(() => {
      result.current.detect([{ id: "a", x: 0, y: 0 }], "a");
    });
    let tick;
    act(() => {
      tick = result.current.detect([{ id: "a", x: 0, y: 0 }], "a");
    });
    expect(tick).toBeNull();
  });

  it("reset() drops the baseline -- the next tick starts fresh, not comparing against pre-reset positions", () => {
    const { result } = renderHook(() => useTickDragDetection());
    act(() => {
      result.current.detect([{ id: "a", x: 0, y: 0 }], "a");
    });
    act(() => {
      result.current.reset();
    });
    let tick;
    act(() => {
      tick = result.current.detect([{ id: "a", x: 999, y: 999 }], "a");
    });
    expect(tick).toBeNull();
  });
});
