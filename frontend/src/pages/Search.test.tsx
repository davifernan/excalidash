import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { SearchPage } from "./Search";

const mockUseSearchPageData = vi.fn();
const mockNavigate = vi.fn();
const mockRestoreDrawing = vi.fn();
const mockArchiveDrawing = vi.fn();

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock("./search/useSearchPageData", () => ({
  useSearchPageData: (...args: unknown[]) => mockUseSearchPageData(...args),
}));

vi.mock("../components/Layout", () => ({
  Layout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("../api", () => ({
  restoreDrawing: (...args: unknown[]) => mockRestoreDrawing(...args),
  archiveDrawing: (...args: unknown[]) => mockArchiveDrawing(...args),
  createCollection: vi.fn(),
  updateCollection: vi.fn(),
  deleteCollection: vi.fn(),
}));

const baseData = {
  mode: "search" as const,
  setMode: vi.fn(),
  query: "",
  setQuery: vi.fn(),
  results: [],
  totalCount: 0,
  status: "idle" as const,
  errorMessage: null,
  collections: [],
  retry: vi.fn(),
};

const result = (overrides: Partial<(typeof baseData)["results"][number]> = {}) => ({
  id: "d1",
  name: "Roadmap",
  collectionId: null,
  archivedAt: null,
  updatedAt: 0,
  createdAt: 0,
  version: 1,
  creatorName: "Ada",
  accessLevel: "owner" as const,
  matchKind: "name" as const,
  elementId: null,
  snippet: null,
  ...overrides,
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <SearchPage />
    </MemoryRouter>,
  );

describe("SearchPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseSearchPageData.mockReturnValue(baseData);
  });

  it("prompts for at least 2 characters before searching", () => {
    renderPage();
    expect(screen.getByText(/type at least 2 characters/i)).toBeInTheDocument();
  });

  it("renders a name match without a content-match badge, and a content match with one and its snippet", () => {
    mockUseSearchPageData.mockReturnValue({
      ...baseData,
      query: "road",
      results: [
        result({ id: "d1", name: "Roadmap", matchKind: "name" }),
        result({
          id: "d2",
          name: "Notes",
          matchKind: "content",
          snippet: "…the roadmap for Q3…",
        }),
      ],
      totalCount: 2,
    });
    renderPage();

    expect(screen.getByText("Roadmap")).toBeInTheDocument();
    expect(screen.getByText("Notes")).toBeInTheDocument();
    expect(screen.getAllByText("content match")).toHaveLength(1);
    expect(screen.getByText("…the roadmap for Q3…")).toBeInTheDocument();
  });

  it("opens a result on click", () => {
    mockUseSearchPageData.mockReturnValue({
      ...baseData,
      query: "road",
      results: [result({ id: "d1", name: "Roadmap" })],
      totalCount: 1,
    });
    renderPage();
    fireEvent.click(screen.getByText("Roadmap"));
    expect(mockNavigate).toHaveBeenCalledWith("/editor/d1");
  });

  it("shows a Restore button only in Archive mode, and calls the API on click", async () => {
    const retry = vi.fn();
    mockRestoreDrawing.mockResolvedValue({ id: "d1", archivedAt: null });
    mockUseSearchPageData.mockReturnValue({
      ...baseData,
      mode: "archive",
      results: [result({ id: "d1", name: "Old board", archivedAt: "2026-01-01T00:00:00Z" })],
      totalCount: 1,
      retry,
    });
    renderPage();

    const restoreButton = screen.getByRole("button", { name: /restore/i });
    fireEvent.click(restoreButton);

    await waitFor(() => expect(mockRestoreDrawing).toHaveBeenCalledWith("d1"));
    await waitFor(() => expect(retry).toHaveBeenCalled());
  });

  it("does not show a Restore button in Search mode", () => {
    mockUseSearchPageData.mockReturnValue({
      ...baseData,
      query: "road",
      results: [result({ id: "d1", name: "Roadmap" })],
      totalCount: 1,
    });
    renderPage();
    expect(screen.queryByRole("button", { name: /restore/i })).not.toBeInTheDocument();
  });

  it("shows the Archive empty state distinctly from the Search empty state", () => {
    mockUseSearchPageData.mockReturnValue({ ...baseData, mode: "archive", results: [] });
    renderPage();
    expect(screen.getByText("Nothing archived")).toBeInTheDocument();
  });

  it("shows an Archive button in Search mode only for a board this account owns, and calls the API on click", async () => {
    const retry = vi.fn();
    mockArchiveDrawing.mockResolvedValue({ id: "d1", archivedAt: "2026-01-01T00:00:00Z" });
    mockUseSearchPageData.mockReturnValue({
      ...baseData,
      query: "road",
      results: [
        result({ id: "d1", name: "Mine", accessLevel: "owner" }),
        result({ id: "d2", name: "Shared with me", accessLevel: "edit" }),
      ],
      totalCount: 2,
      retry,
    });
    renderPage();

    expect(screen.getByRole("button", { name: /archive mine/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /archive shared with me/i }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /archive mine/i }));

    await waitFor(() => expect(mockArchiveDrawing).toHaveBeenCalledWith("d1"));
    await waitFor(() => expect(retry).toHaveBeenCalled());
  });

  it("does not show an Archive button in Archive mode", () => {
    mockUseSearchPageData.mockReturnValue({
      ...baseData,
      mode: "archive",
      results: [result({ id: "d1", name: "Old board", accessLevel: "owner" })],
      totalCount: 1,
    });
    renderPage();
    expect(screen.queryByRole("button", { name: /^archive /i })).not.toBeInTheDocument();
  });
});
