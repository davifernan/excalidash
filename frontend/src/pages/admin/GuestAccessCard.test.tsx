import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { GuestAccessCard } from "./GuestAccessCard";
import { FeatureFlagsProvider } from "../../context/FeatureFlagsContext";

const withAgents = (ui: React.ReactNode, agents = true) => (
  <FeatureFlagsProvider value={{ agents }}>{ui}</FeatureFlagsProvider>
);

describe("GuestAccessCard", () => {
  it("shows Loading while the instance policy has not been fetched yet", () => {
    render(
      withAgents(
        <GuestAccessCard
          uploadFiles={null}
          viewComments={null}
          agentContextContribute={null}
          loading={false}
          onToggleUploadFiles={vi.fn()}
          onToggleViewComments={vi.fn()}
          onToggleAgentContextContribute={vi.fn()}
        />,
      ),
    );

    expect(screen.getAllByText("Loading…")).toHaveLength(3);
  });

  it("shows the persisted state and calls the right handler per toggle", () => {
    const onToggleUploadFiles = vi.fn();
    const onToggleViewComments = vi.fn();
    const onToggleAgentContextContribute = vi.fn();
    render(
      withAgents(
        <GuestAccessCard
          uploadFiles={false}
          viewComments={true}
          agentContextContribute={false}
          loading={false}
          onToggleUploadFiles={onToggleUploadFiles}
          onToggleViewComments={onToggleViewComments}
          onToggleAgentContextContribute={onToggleAgentContextContribute}
        />,
      ),
    );

    expect(screen.getAllByText("Disabled")).toHaveLength(2);
    expect(screen.getByText("Enabled")).toBeInTheDocument();

    fireEvent.click(screen.getAllByText("Disabled")[0]!);
    expect(onToggleUploadFiles).toHaveBeenCalledTimes(1);
    expect(onToggleViewComments).not.toHaveBeenCalled();
    expect(onToggleAgentContextContribute).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Enabled"));
    expect(onToggleViewComments).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getAllByText("Disabled")[1]!);
    expect(onToggleAgentContextContribute).toHaveBeenCalledTimes(1);
  });

  it("disables all three buttons while a save is in flight", () => {
    render(
      withAgents(
        <GuestAccessCard
          uploadFiles={true}
          viewComments={true}
          agentContextContribute={true}
          loading
          onToggleUploadFiles={vi.fn()}
          onToggleViewComments={vi.fn()}
          onToggleAgentContextContribute={vi.fn()}
        />,
      ),
    );

    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled();
    }
  });

  it("hides the Agent Contexts ceiling on a deployment without an agent runtime", () => {
    render(
      withAgents(
        <GuestAccessCard
          uploadFiles={true}
          viewComments={true}
          agentContextContribute={true}
          loading={false}
          onToggleUploadFiles={vi.fn()}
          onToggleViewComments={vi.fn()}
          onToggleAgentContextContribute={vi.fn()}
        />,
        false,
      ),
    );

    // The board half of this ceiling is hidden without a runtime, so the admin
    // half must be too -- otherwise the operator sets a limit nobody can reach.
    expect(screen.getByText("Guest file uploads")).toBeInTheDocument();
    expect(screen.queryByText("Guest contribution to Agent Contexts")).not.toBeInTheDocument();
  });
});
