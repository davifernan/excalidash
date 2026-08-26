import { describe, expect, it } from "vitest";
import { getWorkshopTimerRemainingMs, parseWorkshopTimerSnapshot } from "./workshopTimer";

describe("workshop timer clock synchronization", () => {
  it("derives running time from endsAt after compensating for the client clock", () => {
    const snapshot = parseWorkshopTimerSnapshot(
      {
        drawingId: "drawing-1",
        status: "running",
        endsAt: 660_000,
        remainingMs: 999_999,
        durationMs: 60_000,
        serverNow: 600_000,
      },
      "drawing-1",
      60_000,
    );

    expect(snapshot).not.toBeNull();
    expect(getWorkshopTimerRemainingMs(snapshot!, 75_000)).toBe(45_000);
  });

  it("keeps the server-provided paused remainder fixed", () => {
    const snapshot = parseWorkshopTimerSnapshot(
      {
        drawingId: "drawing-1",
        status: "paused",
        endsAt: null,
        remainingMs: 42_000,
        durationMs: 60_000,
        serverNow: 600_000,
      },
      "drawing-1",
      60_000,
    );

    expect(getWorkshopTimerRemainingMs(snapshot!, 9_000_000)).toBe(42_000);
  });

  it("ignores snapshots for another board", () => {
    expect(
      parseWorkshopTimerSnapshot(
        {
          drawingId: "drawing-2",
          status: "idle",
          endsAt: null,
          remainingMs: 0,
          durationMs: null,
          serverNow: 1,
        },
        "drawing-1",
      ),
    ).toBeNull();
  });

  it("rejects an active timer without the duration required for restart", () => {
    expect(
      parseWorkshopTimerSnapshot(
        {
          drawingId: "drawing-1",
          status: "running",
          endsAt: 60_000,
          remainingMs: 60_000,
          durationMs: null,
          serverNow: 0,
        },
        "drawing-1",
      ),
    ).toBeNull();
  });
});
