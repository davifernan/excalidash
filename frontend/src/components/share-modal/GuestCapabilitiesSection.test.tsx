import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { GuestCapabilitiesSection } from "./GuestCapabilitiesSection";
import type { GuestCapabilitySettings } from "../../api";

const settingsWith = (
  overrides: Partial<GuestCapabilitySettings> = {},
): GuestCapabilitySettings => ({
  board: { uploadFiles: false, viewComments: true, agentContextContribute: false },
  instance: { uploadFiles: true, viewComments: true, agentContextContribute: false },
  effective: { uploadFiles: false, viewComments: true, agentContextContribute: false },
  ...overrides,
});

const noopHandlers = {
  onToggleUploadFiles: vi.fn(),
  onToggleViewComments: vi.fn(),
  onToggleAgentContextContribute: vi.fn(),
};

describe("GuestCapabilitiesSection", () => {
  it("renders nothing while settings have not loaded yet", () => {
    const { container } = render(<GuestCapabilitiesSection settings={null} {...noopHandlers} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lets the owner turn a board capability on when the instance allows it", async () => {
    const onToggleUploadFiles = vi.fn();
    render(
      <GuestCapabilitiesSection
        settings={settingsWith()}
        {...noopHandlers}
        onToggleUploadFiles={onToggleUploadFiles}
      />,
    );

    const offTriggers = screen.getAllByRole("button", { name: /off/i });
    fireEvent.click(offTriggers[0]!);
    const onOptions = screen.getAllByRole("button", { name: "On" });
    fireEvent.click(onOptions[0]!);

    expect(onToggleUploadFiles).toHaveBeenCalledTimes(1);
  });

  it("still lets the owner turn a board capability off while the instance ceiling is closed", async () => {
    // Proves the handler wiring for the off-direction, but NOT reachability:
    // fireEvent.click dispatches synthetically straight on the element and
    // never does real hit-testing, so this stays green even if the trigger
    // sits under a `pointer-events-none` ancestor (jsdom skips hit-testing
    // entirely, so there is nothing for that CSS to block here). The actual
    // regression guard is the next test, which asserts on the DOM state a
    // real click's hit-test would depend on.
    const onToggleUploadFiles = vi.fn();
    render(
      <GuestCapabilitiesSection
        settings={settingsWith({
          board: { uploadFiles: true, viewComments: true, agentContextContribute: false },
          instance: { uploadFiles: false, viewComments: true, agentContextContribute: false },
          effective: { uploadFiles: false, viewComments: true, agentContextContribute: false },
        })}
        {...noopHandlers}
        onToggleUploadFiles={onToggleUploadFiles}
      />,
    );

    // The upload row's trigger is the first one in the DOM.
    const onTriggers = screen.getAllByRole("button", { name: "On" });
    fireEvent.click(onTriggers[0]!);
    const offOptions = screen.getAllByRole("button", { name: "Off" });
    fireEvent.click(offOptions[0]!);

    expect(onToggleUploadFiles).toHaveBeenCalledTimes(1);
  });

  it("never wraps the toggle in a pointer-events lock, even while the instance ceiling is closed", () => {
    // The actual regression guard for the Hans-Friedrich finding on #233:
    // a click-based test can't tell a reachable control from one buried
    // under `pointer-events-none` (see the test above). This asserts
    // directly on the DOM state that determines whether a real click would
    // land -- no ancestor of the toggle carries a class that blocks pointer
    // events -- which is exactly what the old, buggy version of this
    // component violated.
    const { container } = render(
      <GuestCapabilitiesSection
        settings={settingsWith({
          board: { uploadFiles: true, viewComments: true, agentContextContribute: false },
          instance: { uploadFiles: false, viewComments: true, agentContextContribute: false },
          effective: { uploadFiles: false, viewComments: true, agentContextContribute: false },
        })}
        {...noopHandlers}
      />,
    );

    expect(container.querySelector(".pointer-events-none")).toBeNull();
    const onTriggers = screen.getAllByRole("button", { name: "On" });
    expect(onTriggers[0]!.closest(".pointer-events-none")).toBeNull();
  });

  it("shows that the instance ceiling blocks the board even though the board opted in", () => {
    render(
      <GuestCapabilitiesSection
        settings={settingsWith({
          board: { uploadFiles: true, viewComments: true, agentContextContribute: false },
          instance: { uploadFiles: false, viewComments: true, agentContextContribute: false },
          effective: { uploadFiles: false, viewComments: true, agentContextContribute: false },
        })}
        {...noopHandlers}
      />,
    );

    expect(screen.getAllByText(/disabled instance-wide by an admin/i).length).toBeGreaterThan(0);
  });

  it("says guests can see comments when both levels agree", () => {
    render(<GuestCapabilitiesSection settings={settingsWith()} {...noopHandlers} />);

    expect(screen.getByText(/guests can see comments on this board/i)).toBeInTheDocument();
  });

  it("shows that a guest's own content stays out of Agent Contexts by default", () => {
    render(
      <GuestCapabilitiesSection
        settings={settingsWith({
          instance: { uploadFiles: true, viewComments: true, agentContextContribute: true },
        })}
        {...noopHandlers}
      />,
    );

    expect(
      screen.getByText(/is never read by an agent working in this board's Agent Contexts/i),
    ).toBeInTheDocument();
  });

  it("lets the owner turn on Agent Context contribution and calls the right handler", () => {
    const onToggleAgentContextContribute = vi.fn();
    render(
      <GuestCapabilitiesSection
        settings={settingsWith({
          instance: { uploadFiles: true, viewComments: true, agentContextContribute: true },
        })}
        {...noopHandlers}
        onToggleAgentContextContribute={onToggleAgentContextContribute}
      />,
    );

    const offTriggers = screen.getAllByRole("button", { name: /off/i });
    fireEvent.click(offTriggers[offTriggers.length - 1]!);
    const onOptions = screen.getAllByRole("button", { name: "On" });
    fireEvent.click(onOptions[onOptions.length - 1]!);

    expect(onToggleAgentContextContribute).toHaveBeenCalledTimes(1);
  });
});
