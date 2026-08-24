import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TeamLibrary } from "./TeamLibrary";

const mockGetLibraryItems = vi.fn();
const mockUpdateLibraryItem = vi.fn();
const mockDeleteLibraryItem = vi.fn();
const mockGetCollections = vi.fn();

vi.mock("../components/Layout", () => ({
  Layout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("../api", () => ({
  getLibraryItems: (...args: unknown[]) => mockGetLibraryItems(...args),
  updateLibraryItem: (...args: unknown[]) => mockUpdateLibraryItem(...args),
  deleteLibraryItem: (...args: unknown[]) => mockDeleteLibraryItem(...args),
  getCollections: (...args: unknown[]) => mockGetCollections(...args),
  createCollection: vi.fn(),
  updateCollection: vi.fn(),
  deleteCollection: vi.fn(),
  exportLibraryItems: vi.fn(),
  importLibraryItems: vi.fn(),
}));

const item = (overrides: Record<string, unknown> = {}) => ({
  id: "row-1",
  name: "Sticky note",
  category: null,
  visibility: "personal",
  ownerUserId: "me",
  ownerName: "Me",
  isMine: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  ...overrides,
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <TeamLibrary />
    </MemoryRouter>,
  );

describe("TeamLibrary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCollections.mockResolvedValue([]);
  });

  it("shows the empty state when there are no items", async () => {
    mockGetLibraryItems.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText("Nothing in the library yet")).toBeInTheDocument();
  });

  it("does not offer a Publish/Delete control for an item owned by someone else", async () => {
    mockGetLibraryItems.mockResolvedValue([
      item({
        id: "theirs",
        name: "Team template",
        visibility: "team",
        isMine: false,
        ownerName: "Bob",
      }),
    ]);
    renderPage();
    expect(await screen.findByText("Team template")).toBeInTheDocument();
    expect(screen.getByText(/added by Bob/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /publish to team|make personal/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /delete team template/i })).not.toBeInTheDocument();
  });

  it("publishes a personal item to the team and reflects the response", async () => {
    mockGetLibraryItems.mockResolvedValue([item({ visibility: "personal" })]);
    mockUpdateLibraryItem.mockResolvedValue(item({ visibility: "team" }));
    renderPage();

    const publishButton = await screen.findByRole("button", { name: /publish to team/i });
    fireEvent.click(publishButton);

    await waitFor(() =>
      expect(mockUpdateLibraryItem).toHaveBeenCalledWith("row-1", { visibility: "team" }),
    );
    expect(await screen.findByRole("button", { name: /make personal/i })).toBeInTheDocument();
  });

  it("deletes an owned item on confirmation and removes it from the list", async () => {
    mockGetLibraryItems.mockResolvedValue([item()]);
    mockDeleteLibraryItem.mockResolvedValue(undefined);
    renderPage();

    const deleteButton = await screen.findByRole("button", { name: /delete sticky note/i });
    fireEvent.click(deleteButton);

    await waitFor(() => expect(mockDeleteLibraryItem).toHaveBeenCalledWith("row-1"));
    await waitFor(() => expect(screen.queryByText("Sticky note")).not.toBeInTheDocument());
  });
});
