import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { OffscreenPresenceOverlay } from "./OffscreenPresenceOverlay";
import type { OffscreenMarker } from "./offscreenPresenceGeometry";

afterEach(() => {
  cleanup();
});

const marker = (overrides: Partial<OffscreenMarker> = {}): OffscreenMarker => ({
  key: "offscreen-0",
  left: 10,
  top: 20,
  angleDeg: 0,
  color: "#ff0000",
  count: 1,
  names: ["Ada"],
  ...overrides,
});

describe("OffscreenPresenceOverlay", () => {
  it("renders nothing when there are no markers", () => {
    render(<OffscreenPresenceOverlay markers={[]} />);
    expect(screen.queryByTestId("offscreen-presence")).toBeNull();
  });

  it("renders one marker without a count badge for a single collaborator", () => {
    render(<OffscreenPresenceOverlay markers={[marker()]} />);
    expect(screen.getAllByTestId("offscreen-presence-marker")).toHaveLength(1);
    expect(screen.getByRole("img", { name: "Ada is off-screen" })).toBeInTheDocument();
    expect(screen.queryByText("2")).toBeNull();
  });

  it("shows a count badge and every name in the label for a clustered marker", () => {
    render(
      <OffscreenPresenceOverlay
        markers={[marker({ count: 2, names: ["Ada", "Bo"], color: null })]}
      />,
    );
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "2 collaborators are off-screen: Ada, Bo" }),
    ).toBeInTheDocument();
  });

  it("renders one marker per entry", () => {
    render(
      <OffscreenPresenceOverlay
        markers={[marker({ key: "a" }), marker({ key: "b", left: 90, top: 5 })]}
      />,
    );
    expect(screen.getAllByTestId("offscreen-presence-marker")).toHaveLength(2);
  });
});
