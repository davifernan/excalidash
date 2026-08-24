import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DrawingCard } from "./DrawingCard";
import type { DrawingSummary } from "../types";

vi.mock("../api", () => ({
  getDrawing: vi.fn(),
  isS3Enabled: vi.fn().mockResolvedValue(false),
}));

const baseDrawing: DrawingSummary = {
  id: "d1",
  name: "Roadmap Q4",
  collectionId: null,
  updatedAt: Date.now(),
  createdAt: Date.now(),
  version: 1,
  preview: null,
};

describe("DrawingCard favorite toggle (NIL-292)", () => {
  it("does not render a star button when no handler is given (e.g. trash)", () => {
    render(
      <DrawingCard
        drawing={baseDrawing}
        collections={[]}
        isSelected={false}
        onToggleSelection={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onMoveToCollection={vi.fn()}
        onDuplicate={vi.fn()}
        onClick={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText(/star roadmap q4/i)).not.toBeInTheDocument();
  });

  it("stars an unstarred board on click, without opening the editor", () => {
    const onToggleFavorite = vi.fn();
    const onClick = vi.fn();
    render(
      <DrawingCard
        drawing={baseDrawing}
        collections={[]}
        isSelected={false}
        onToggleSelection={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onMoveToCollection={vi.fn()}
        onDuplicate={vi.fn()}
        onClick={onClick}
        onToggleFavorite={onToggleFavorite}
      />,
    );

    screen.getByLabelText("Star Roadmap Q4").click();

    expect(onToggleFavorite).toHaveBeenCalledWith("d1", true);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("unstars an already-starred board", () => {
    const onToggleFavorite = vi.fn();
    render(
      <DrawingCard
        drawing={{ ...baseDrawing, isFavorite: true }}
        collections={[]}
        isSelected={false}
        onToggleSelection={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onMoveToCollection={vi.fn()}
        onDuplicate={vi.fn()}
        onClick={vi.fn()}
        onToggleFavorite={onToggleFavorite}
      />,
    );

    const button = screen.getByLabelText("Unstar Roadmap Q4");
    expect(button).toHaveAttribute("aria-pressed", "true");
    button.click();

    expect(onToggleFavorite).toHaveBeenCalledWith("d1", false);
  });
});
