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

const renderCard = (drawing: DrawingSummary) =>
  render(
    <DrawingCard
      drawing={drawing}
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

describe("DrawingCard provenance badge (NIL-290)", () => {
  it("shows no badge for a private board with no provenance signal", () => {
    renderCard(baseDrawing);
    expect(screen.queryByTestId("provenance-badge-collection")).not.toBeInTheDocument();
    expect(screen.queryByTestId("provenance-badge-direct")).not.toBeInTheDocument();
    expect(screen.queryByTestId("provenance-badge-link")).not.toBeInTheDocument();
  });

  it("shows 'Via collection' for a board reached through a shared collection", () => {
    renderCard({ ...baseDrawing, accessVia: "collection" });
    expect(screen.getByTestId("provenance-badge-collection")).toHaveTextContent("Via collection");
  });

  it("shows 'Shared directly' for a board reached through a direct grant", () => {
    renderCard({ ...baseDrawing, accessVia: "direct" });
    expect(screen.getByTestId("provenance-badge-direct")).toHaveTextContent("Shared directly");
  });

  it("shows a Link badge when the owner's board has an active link share", () => {
    renderCard({ ...baseDrawing, linkShared: true });
    expect(screen.getByTestId("provenance-badge-link")).toHaveTextContent("Link");
  });

  it("does not show a Link badge when linkShared is explicitly false", () => {
    renderCard({ ...baseDrawing, linkShared: false });
    expect(screen.queryByTestId("provenance-badge-link")).not.toBeInTheDocument();
  });

  it("can show both accessVia and a Link badge together", () => {
    renderCard({ ...baseDrawing, accessVia: "collection", linkShared: true });
    expect(screen.getByTestId("provenance-badge-collection")).toBeInTheDocument();
    expect(screen.getByTestId("provenance-badge-link")).toBeInTheDocument();
  });
});
