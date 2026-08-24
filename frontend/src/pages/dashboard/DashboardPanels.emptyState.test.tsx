import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DrawingsGrid } from "./DashboardPanels";

const baseProps = {
  drawings: [],
  collections: [],
  selectedIds: new Set<string>(),
  search: "",
  isLoading: false,
  isDraggingFile: false,
  isTrashView: false,
  isSharedView: false,
  isSharedCollection: false,
  onClearSearch: vi.fn(),
  onToggleSelection: vi.fn(),
  onRename: vi.fn(),
  onDelete: vi.fn(),
  onDuplicate: vi.fn(),
  onMoveToCollection: vi.fn(),
  onOpenDrawing: vi.fn(),
  onMouseDown: vi.fn(),
  onDragStart: vi.fn(),
  onPreviewGenerated: vi.fn(),
};

describe("DrawingsGrid empty state (NIL-292)", () => {
  it("says the plain default when nothing narrows the view", () => {
    render(<DrawingsGrid {...baseProps} />);
    expect(screen.getByText("No drawings found")).toBeInTheDocument();
    expect(screen.getByText("Create a new drawing to get started!")).toBeInTheDocument();
  });

  it("prioritizes the search explanation over trash", () => {
    render(<DrawingsGrid {...baseProps} search="roadmap" />);
    expect(screen.getByText('No results for "roadmap"')).toBeInTheDocument();
    screen.getByText("Clear search").click();
    expect(baseProps.onClearSearch).toHaveBeenCalled();
  });

  it("explains an empty 'Open now' filter distinctly from an empty board list, with a way to clear it", () => {
    const onClearOpenOnly = vi.fn();
    render(<DrawingsGrid {...baseProps} openOnly onClearOpenOnly={onClearOpenOnly} />);
    expect(screen.getByText("Nothing open right now")).toBeInTheDocument();
    screen.getByText("Clear filter").click();
    expect(onClearOpenOnly).toHaveBeenCalled();
  });

  it("explains an empty favorites filter, with a way to clear it", () => {
    const onClearFavoritesOnly = vi.fn();
    render(
      <DrawingsGrid {...baseProps} favoritesOnly onClearFavoritesOnly={onClearFavoritesOnly} />,
    );
    expect(screen.getByText("No favorites yet")).toBeInTheDocument();
    screen.getByText("Clear filter").click();
    expect(onClearFavoritesOnly).toHaveBeenCalled();
  });

  it("says nothing has been shared yet on an empty 'Shared with me' view, not the generic message", () => {
    render(<DrawingsGrid {...baseProps} isSharedView />);
    expect(screen.getByText("Nothing shared with you yet")).toBeInTheDocument();
    expect(screen.queryByText("Create a new drawing to get started!")).not.toBeInTheDocument();
  });

  it("tells a view-only member of a shared collection to ask an editor, not to create one themselves", () => {
    render(
      <DrawingsGrid
        {...baseProps}
        isSharedCollection
        currentCollection={{
          id: "c1",
          name: "Team Board",
          createdAt: 0,
          isOwner: false,
          sharedRole: "view",
        }}
      />,
    );
    expect(screen.getByText(/ask an editor to add one/i)).toBeInTheDocument();
  });

  it("invites an editor of a shared collection to create the first board", () => {
    render(
      <DrawingsGrid
        {...baseProps}
        isSharedCollection
        currentCollection={{
          id: "c1",
          name: "Team Board",
          createdAt: 0,
          isOwner: false,
          sharedRole: "edit",
        }}
      />,
    );
    expect(
      screen.getByText("Create the first board in this collection to get started!"),
    ).toBeInTheDocument();
  });

  it("keeps the plain trash message even when a filter happens to be set", () => {
    render(<DrawingsGrid {...baseProps} isTrashView favoritesOnly openOnly />);
    expect(screen.getByText("Your trash is empty")).toBeInTheDocument();
  });
});
