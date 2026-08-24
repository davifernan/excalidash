import { render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { DashboardToolbar } from "./DashboardToolbar";

const baseProps = {
  search: "",
  searchInputRef: createRef<HTMLInputElement>(),
  sortConfig: { field: "updatedAt" as const, direction: "desc" as const },
  sortOptions: [{ field: "updatedAt" as const, label: "Date Modified", icon: null }],
  currentSortOption: { field: "updatedAt" as const, label: "Date Modified", icon: null },
  showSortMenu: false,
  sortedDrawingsCount: 0,
  allSelected: false,
  hasSelection: false,
  isTrashView: false,
  isSharedView: false,
  isSharedCollection: false,
  showBulkMoveMenu: false,
  selectedCount: 0,
  collections: [],
  onSearchChange: vi.fn(),
  onShowSortMenuChange: vi.fn(),
  onSortFieldChange: vi.fn(),
  onSortDirectionToggle: vi.fn(),
  onSelectAll: vi.fn(),
  onBulkDeleteClick: vi.fn(),
  onBulkDuplicate: vi.fn(),
  onShowBulkMoveMenuChange: vi.fn(),
  onBulkMove: vi.fn(),
  onImportDrawings: vi.fn(),
  onCreateDrawing: vi.fn(),
  onViewerActionError: vi.fn(),
};

describe("DashboardToolbar filters (NIL-292)", () => {
  it("does not render a filter button when no handler is given", () => {
    render(<DashboardToolbar {...baseProps} />);
    expect(screen.queryByLabelText(/favorites/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/open now/i)).not.toBeInTheDocument();
  });

  it("toggles favoritesOnly on click and reflects the active state", () => {
    const onToggleFavoritesOnly = vi.fn();
    render(
      <DashboardToolbar {...baseProps} favoritesOnly={false} onToggleFavoritesOnly={onToggleFavoritesOnly} />,
    );

    const button = screen.getByLabelText("Show favorites only");
    expect(button).toHaveAttribute("aria-pressed", "false");
    button.click();
    expect(onToggleFavoritesOnly).toHaveBeenCalledTimes(1);
  });

  it("shows the active label and state once favoritesOnly is on", () => {
    render(<DashboardToolbar {...baseProps} favoritesOnly onToggleFavoritesOnly={vi.fn()} />);
    const button = screen.getByLabelText("Showing favorites only");
    expect(button).toHaveAttribute("aria-pressed", "true");
  });

  it("toggles openOnly independently of favoritesOnly", () => {
    const onToggleOpenOnly = vi.fn();
    render(<DashboardToolbar {...baseProps} openOnly={false} onToggleOpenOnly={onToggleOpenOnly} />);

    const button = screen.getByLabelText("Show boards open right now");
    button.click();
    expect(onToggleOpenOnly).toHaveBeenCalledTimes(1);
  });
});
