import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIMER_MARGIN,
  DEFAULT_TIMER_POSITION,
  clampTimerPosition,
  nudgeTimerPosition,
  parseStoredTimerPosition,
  shouldOpenPanelDownward,
  shouldOpenPanelRightward,
  timerPositionStorageKey,
} from "./timerPosition";

const bounds = { containerWidth: 1000, containerHeight: 800, widgetWidth: 120, widgetHeight: 44 };

describe("clampTimerPosition", () => {
  it("leaves a position that already fits untouched", () => {
    expect(clampTimerPosition({ right: 50, bottom: 50 }, bounds)).toEqual({
      right: 50,
      bottom: 50,
    });
  });

  it("pulls a negative offset back to the edge", () => {
    expect(clampTimerPosition({ right: -20, bottom: -5 }, bounds)).toEqual({
      right: 0,
      bottom: 0,
    });
  });

  it("pulls an offset that would push the widget past the far edge back in", () => {
    // containerWidth - widgetWidth = 880, containerHeight - widgetHeight = 756
    expect(clampTimerPosition({ right: 5000, bottom: 5000 }, bounds)).toEqual({
      right: 880,
      bottom: 756,
    });
  });

  it("clamps each axis independently", () => {
    expect(clampTimerPosition({ right: -10, bottom: 5000 }, bounds)).toEqual({
      right: 0,
      bottom: 756,
    });
  });

  it("never asks for a negative max when the widget is bigger than the container", () => {
    // widgetWidth (120) exceeds containerWidth (50): right clamps to 0, the
    // floor `Math.max(0, ...)` guard against a negative max is what's under
    // test. Height still fits (50 - 44 = 6), so bottom clamps to that, not 0.
    const tiny = { containerWidth: 50, containerHeight: 50, widgetWidth: 120, widgetHeight: 44 };
    expect(clampTimerPosition({ right: 30, bottom: 30 }, tiny)).toEqual({ right: 0, bottom: 6 });
  });
});

describe("nudgeTimerPosition", () => {
  it("moves up by increasing the bottom offset", () => {
    expect(nudgeTimerPosition({ right: 100, bottom: 100 }, "ArrowUp", bounds)).toEqual({
      right: 100,
      bottom: 108,
    });
  });

  it("moves right by decreasing the right offset", () => {
    expect(nudgeTimerPosition({ right: 100, bottom: 100 }, "ArrowRight", bounds)).toEqual({
      right: 92,
      bottom: 100,
    });
  });

  it("takes a bigger step with the large option, for covering distance", () => {
    expect(
      nudgeTimerPosition({ right: 100, bottom: 100 }, "ArrowLeft", bounds, { large: true }),
    ).toEqual({ right: 132, bottom: 100 });
  });

  it("clamps a nudge that would push the widget out of bounds", () => {
    expect(nudgeTimerPosition({ right: 0, bottom: 0 }, "ArrowRight", bounds)).toEqual({
      right: 0,
      bottom: 0,
    });
  });
});

describe("shouldOpenPanelDownward", () => {
  it("opens upward for the default bottom-right corner (plenty of room above)", () => {
    expect(shouldOpenPanelDownward(DEFAULT_TIMER_POSITION, bounds, 200)).toBe(false);
  });

  it("opens downward once the widget is close enough to the top", () => {
    const nearTop = { right: 16, bottom: bounds.containerHeight - 60 };
    expect(shouldOpenPanelDownward(nearTop, bounds, 200)).toBe(true);
  });
});

describe("shouldOpenPanelRightward", () => {
  it("grows leftward for the default bottom-right corner (plenty of room to the left)", () => {
    expect(shouldOpenPanelRightward(DEFAULT_TIMER_POSITION, bounds, 270)).toBe(false);
  });

  it("grows rightward once the widget is close enough to the left edge", () => {
    // small-windows.spec.ts's original bug, on a widget that can now be
    // dragged anywhere: growing leftward here would run off the left edge.
    const nearLeftEdge = { right: bounds.containerWidth - 60, bottom: 16 };
    expect(shouldOpenPanelRightward(nearLeftEdge, bounds, 270)).toBe(true);
  });

  it("still grows leftward for the default corner on a narrow (mobile) container", () => {
    // Caught by the real browser, not this suite, the first time: a formula
    // that also subtracted widgetWidth measured the gap to the *left* of the
    // widget instead of the gap available for leftward growth from its right
    // edge, and flipped this case to rightward growth on a 390px viewport --
    // running the minutes field off the right edge instead of the left.
    const mobileBounds = {
      containerWidth: 390,
      containerHeight: 844,
      widgetWidth: 170,
      widgetHeight: 40,
    };
    expect(shouldOpenPanelRightward(DEFAULT_TIMER_POSITION, mobileBounds, 270)).toBe(false);
  });
});

describe("parseStoredTimerPosition", () => {
  it("reads back a value it could have written", () => {
    const raw = JSON.stringify({ right: 40, bottom: 60 });
    expect(parseStoredTimerPosition(raw)).toEqual({ right: 40, bottom: 60 });
  });

  it("falls back to null for missing storage", () => {
    expect(parseStoredTimerPosition(null)).toBeNull();
  });

  it("falls back to null for malformed JSON instead of throwing", () => {
    expect(parseStoredTimerPosition("{not json")).toBeNull();
  });

  it("falls back to null for a foreign value with the wrong shape", () => {
    expect(parseStoredTimerPosition(JSON.stringify({ x: 1, y: 2 }))).toBeNull();
    expect(parseStoredTimerPosition(JSON.stringify({ right: "40", bottom: 60 }))).toBeNull();
    expect(parseStoredTimerPosition(JSON.stringify(null))).toBeNull();
  });
});

describe("timerPositionStorageKey", () => {
  it("scopes the key to the drawing so two boards never share a position", () => {
    expect(timerPositionStorageKey("board-a")).not.toBe(timerPositionStorageKey("board-b"));
    expect(timerPositionStorageKey("board-a")).toContain("board-a");
  });
});

it("defaults to the bottom-right corner, at the shared chrome margin", () => {
  expect(DEFAULT_TIMER_POSITION).toEqual({
    right: DEFAULT_TIMER_MARGIN,
    bottom: DEFAULT_TIMER_MARGIN,
  });
});
