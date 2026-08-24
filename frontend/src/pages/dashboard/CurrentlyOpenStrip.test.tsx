import React from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CurrentlyOpenStrip } from "./CurrentlyOpenStrip";
import type { DrawingSummary } from "../../types";
import type { PresenceByDrawing } from "./useDashboardPresence";

const drawing = (id: string, name: string): DrawingSummary => ({
  id,
  name,
  collectionId: null,
  updatedAt: Date.now(),
  createdAt: Date.now(),
  version: 1,
});

describe("CurrentlyOpenStrip", () => {
  it("renders nothing when presence is unknown", () => {
    render(
      <CurrentlyOpenStrip drawings={[drawing("d1", "Roadmap")]} presence={null} onOpenDrawing={() => {}} />,
    );
    expect(screen.queryByTestId("currently-open-strip")).not.toBeInTheDocument();
  });

  it("renders nothing when every board is confirmed empty", () => {
    const presence: PresenceByDrawing = new Map([
      ["d1", { keys: new Set(), guestCount: 0 }],
    ]);
    render(
      <CurrentlyOpenStrip drawings={[drawing("d1", "Roadmap")]} presence={presence} onOpenDrawing={() => {}} />,
    );
    expect(screen.queryByTestId("currently-open-strip")).not.toBeInTheDocument();
  });

  it("shows only the boards confirmed to have someone on them, not boards presence hasn't answered for", () => {
    // d1: confirmed occupied. d2: confirmed empty. d3: not in the presence
    // map at all -- e.g. past MAX_WATCHED -- must not appear either way.
    const presence: PresenceByDrawing = new Map([
      ["d1", { keys: new Set(["k1"]), guestCount: 0 }],
      ["d2", { keys: new Set(), guestCount: 0 }],
    ]);
    render(
      <CurrentlyOpenStrip
        drawings={[drawing("d1", "Roadmap Q4"), drawing("d2", "Empty Board"), drawing("d3", "Unwatched Board")]}
        presence={presence}
        onOpenDrawing={() => {}}
      />,
    );
    expect(screen.getByTestId("currently-open-strip")).toBeInTheDocument();
    expect(screen.getByText("Roadmap Q4")).toBeInTheDocument();
    expect(screen.queryByText("Empty Board")).not.toBeInTheDocument();
    expect(screen.queryByText("Unwatched Board")).not.toBeInTheDocument();
  });

  it("counts a guest-only board as open too", () => {
    const presence: PresenceByDrawing = new Map([["d1", { keys: new Set(), guestCount: 1 }]]);
    render(
      <CurrentlyOpenStrip drawings={[drawing("d1", "Guest Board")]} presence={presence} onOpenDrawing={() => {}} />,
    );
    expect(screen.getByText("Guest Board")).toBeInTheDocument();
  });

  it("opens the board when its pill is clicked", () => {
    const presence: PresenceByDrawing = new Map([["d1", { keys: new Set(["k1"]), guestCount: 0 }]]);
    let opened: string | null = null;
    render(
      <CurrentlyOpenStrip
        drawings={[drawing("d1", "Roadmap Q4")]}
        presence={presence}
        onOpenDrawing={(id) => {
          opened = id;
        }}
      />,
    );
    screen.getByText("Roadmap Q4").closest("button")!.click();
    expect(opened).toBe("d1");
  });
});
