import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { GuestAccessCard } from "./GuestAccessCard";

describe("GuestAccessCard", () => {
  it("shows Loading while the instance policy has not been fetched yet", () => {
    render(
      <GuestAccessCard
        uploadFiles={null}
        viewComments={null}
        loading={false}
        onToggleUploadFiles={vi.fn()}
        onToggleViewComments={vi.fn()}
      />,
    );

    expect(screen.getAllByText("Loading…")).toHaveLength(2);
  });

  it("shows the persisted state and calls the right handler per toggle", () => {
    const onToggleUploadFiles = vi.fn();
    const onToggleViewComments = vi.fn();
    render(
      <GuestAccessCard
        uploadFiles={false}
        viewComments={true}
        loading={false}
        onToggleUploadFiles={onToggleUploadFiles}
        onToggleViewComments={onToggleViewComments}
      />,
    );

    expect(screen.getByText("Disabled")).toBeInTheDocument();
    expect(screen.getByText("Enabled")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Disabled"));
    expect(onToggleUploadFiles).toHaveBeenCalledTimes(1);
    expect(onToggleViewComments).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Enabled"));
    expect(onToggleViewComments).toHaveBeenCalledTimes(1);
  });

  it("disables both buttons while a save is in flight", () => {
    render(
      <GuestAccessCard
        uploadFiles={true}
        viewComments={true}
        loading
        onToggleUploadFiles={vi.fn()}
        onToggleViewComments={vi.fn()}
      />,
    );

    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled();
    }
  });
});
