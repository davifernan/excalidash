import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { GuestCapabilitiesSection } from "./GuestCapabilitiesSection";
import type { GuestCapabilitySettings } from "../../api";

const settingsWith = (
  overrides: Partial<GuestCapabilitySettings> = {},
): GuestCapabilitySettings => ({
  board: { uploadFiles: false, viewComments: true },
  instance: { uploadFiles: true, viewComments: true },
  effective: { uploadFiles: false, viewComments: true },
  ...overrides,
});

describe("GuestCapabilitiesSection", () => {
  it("renders nothing while settings have not loaded yet", () => {
    const { container } = render(
      <GuestCapabilitiesSection
        settings={null}
        onToggleUploadFiles={vi.fn()}
        onToggleViewComments={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("lets the owner turn a board capability on when the instance allows it", async () => {
    const onToggleUploadFiles = vi.fn();
    render(
      <GuestCapabilitiesSection
        settings={settingsWith()}
        onToggleUploadFiles={onToggleUploadFiles}
        onToggleViewComments={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /off/i }));
    const onOptions = screen.getAllByRole("button", { name: "On" });
    fireEvent.click(onOptions[0]);

    expect(onToggleUploadFiles).toHaveBeenCalledTimes(1);
  });

  it("shows that the instance ceiling blocks the board even though the board opted in", () => {
    render(
      <GuestCapabilitiesSection
        settings={settingsWith({
          board: { uploadFiles: true, viewComments: true },
          instance: { uploadFiles: false, viewComments: true },
          effective: { uploadFiles: false, viewComments: true },
        })}
        onToggleUploadFiles={vi.fn()}
        onToggleViewComments={vi.fn()}
      />,
    );

    expect(screen.getByText(/disabled instance-wide by an admin/i)).toBeInTheDocument();
  });

  it("says guests can see comments when both levels agree", () => {
    render(
      <GuestCapabilitiesSection
        settings={settingsWith()}
        onToggleUploadFiles={vi.fn()}
        onToggleViewComments={vi.fn()}
      />,
    );

    expect(screen.getByText(/guests can see comments on this board/i)).toBeInTheDocument();
  });
});
