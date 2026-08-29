import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentPresenceOverlay } from "./AgentPresenceOverlay";

describe("AgentPresenceOverlay", () => {
  it("binds a named agent and immutable revision to the highlighted board target", () => {
    render(
      <AgentPresenceOverlay
        boxes={[
          {
            key: "run-a:frame-a",
            targetId: "frame-a",
            left: 20,
            top: 30,
            width: 240,
            height: 160,
            color: "#7c3aed",
            opacity: 1,
            label: "Research · reading",
            labelOffset: 0,
            revisionId: "revision-17",
          },
        ]}
      />,
    );
    expect(screen.getByText(/Research · reading/)).toBeInTheDocument();
    expect(screen.getByTestId("agent-presence-highlight")).toHaveAttribute(
      "data-revision-id",
      "revision-17",
    );
    expect(screen.getByTestId("agent-presence-highlight")).toHaveAttribute(
      "data-target-id",
      "frame-a",
    );
  });

  it("renders a trail without claiming that the agent is still reading there", () => {
    render(
      <AgentPresenceOverlay
        boxes={[
          {
            key: "run-a:trail:frame-a",
            targetId: "frame-a",
            left: 20,
            top: 30,
            width: 240,
            height: 160,
            color: "#7c3aed",
            opacity: 0.4,
            label: null,
            labelOffset: 0,
            revisionId: "revision-17",
          },
        ]}
      />,
    );
    expect(screen.queryByText(/reading/)).not.toBeInTheDocument();
  });
});
