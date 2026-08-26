import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { CommandPalette } from "./CommandPalette";

const { navigate, search, createDrawing, createCollection, notification } = vi.hoisted(() => ({
  navigate: vi.fn(),
  search: vi.fn(),
  createDrawing: vi.fn(),
  createCollection: vi.fn(),
  notification: vi.fn(),
}));

vi.mock("react-router-dom", () => ({ useNavigate: () => navigate }));
vi.mock("../notifications", () => ({ notify: notification }));
vi.mock("../api", () => ({
  search,
  createDrawing,
  createCollection,
}));

const board = (
  overrides: Partial<{ id: string; name: string; creatorName: string | null }> = {},
) => ({
  id: "b1",
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

describe("CommandPalette", () => {
  beforeEach(() => {
    navigate.mockReset();
    search.mockReset().mockResolvedValue({ results: [], totalCount: 0, limit: 8, offset: 0 });
    createDrawing.mockReset();
    createCollection.mockReset();
    notification.mockReset();
  });

  it("renders nothing when closed", () => {
    render(<CommandPalette isOpen={false} onClose={vi.fn()} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows the four static actions with an empty query", () => {
    render(<CommandPalette isOpen onClose={vi.fn()} />);
    expect(screen.getByText("Go to Team Home")).toBeInTheDocument();
    expect(screen.getByText("Go to Dashboard")).toBeInTheDocument();
    expect(screen.getByText("New board")).toBeInTheDocument();
    expect(screen.getByText("New collection")).toBeInTheDocument();
  });

  it("filters static actions by the typed query", () => {
    render(<CommandPalette isOpen onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/search boards/i), {
      target: { value: "team" },
    });
    expect(screen.getByText("Go to Team Home")).toBeInTheDocument();
    expect(screen.queryByText("Go to Dashboard")).not.toBeInTheDocument();
    expect(screen.queryByText("New board")).not.toBeInTheDocument();
  });

  it("navigates to Team Home and closes", () => {
    const onClose = vi.fn();
    render(<CommandPalette isOpen onClose={onClose} />);
    fireEvent.click(screen.getByText("Go to Team Home"));
    expect(navigate).toHaveBeenCalledWith("/team");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("searches boards as the user types and lists permission-filtered results", async () => {
    search.mockResolvedValue({
      results: [board({ id: "b1", name: "Roadmap" })],
      totalCount: 1,
      limit: 8,
      offset: 0,
    });
    render(<CommandPalette isOpen onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/search boards/i), {
      target: { value: "road" },
    });
    await waitFor(() => expect(search).toHaveBeenCalledWith({ q: "road", limit: 8 }));
    expect(await screen.findByText("Roadmap")).toBeInTheDocument();
    expect(screen.getByText("by Ada")).toBeInTheDocument();
  });

  it("opens the highlighted board and closes on Enter", async () => {
    search.mockResolvedValue({
      results: [board({ id: "b1", name: "Roadmap" })],
      totalCount: 1,
      limit: 8,
      offset: 0,
    });
    const onClose = vi.fn();
    render(<CommandPalette isOpen onClose={onClose} />);
    const input = screen.getByPlaceholderText(/search boards/i);
    fireEvent.change(input, { target: { value: "road" } });
    await screen.findByText("Roadmap");

    // Query non-empty -> static actions are filtered out (none match "road"),
    // so the one board result is item index 0. keydown bubbles from the
    // input up to the dialog's own handler.
    fireEvent.keyDown(input, { key: "Enter" });

    expect(navigate).toHaveBeenCalledWith("/editor/b1");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("resets the highlight when a new result set arrives, even if the count stays the same (Hans PR #62-R1)", async () => {
    // Reported scenario: type "road" -> two results, ArrowDown to the 2nd
    // ("Roadwork") -> type "roads" -> a different two results ("Roadster"
    // instead of "Roadwork"). highlightedIndex must not still point at
    // position 1 meaning "whatever board is there now" -- Enter must not
    // silently open a board the user never highlighted.
    search.mockResolvedValueOnce({
      results: [
        board({ id: "b-inn", name: "Inn Notes" }),
        board({ id: "b-work", name: "Roadwork" }),
      ],
      totalCount: 2,
      limit: 8,
      offset: 0,
    });
    const onClose = vi.fn();
    render(<CommandPalette isOpen onClose={onClose} />);
    const input = screen.getByPlaceholderText(/search boards/i);

    fireEvent.change(input, { target: { value: "road" } });
    await screen.findByText("Roadwork");
    fireEvent.keyDown(input, { key: "ArrowDown" }); // highlight index 1: "Roadwork"

    search.mockResolvedValueOnce({
      results: [
        board({ id: "b-side", name: "Roadside" }),
        board({ id: "b-ster", name: "Roadster" }),
      ],
      totalCount: 2,
      limit: 8,
      offset: 0,
    });
    fireEvent.change(input, { target: { value: "roads" } });
    await screen.findByText("Roadster");
    expect(screen.queryByText("Roadwork")).not.toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Enter" });

    expect(navigate).toHaveBeenCalledWith("/editor/b-side");
    expect(navigate).not.toHaveBeenCalledWith("/editor/b-ster");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows a compact retry-able error when board search fails", async () => {
    search.mockRejectedValue(new Error("network down"));
    render(<CommandPalette isOpen onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/search boards/i), {
      target: { value: "road" },
    });
    expect((await screen.findAllByText("Couldn't search boards.")).length).toBeGreaterThan(0);

    search.mockResolvedValue({
      results: [board()],
      totalCount: 1,
      limit: 8,
      offset: 0,
    });
    fireEvent.click(screen.getByText("Try again"));
    expect(await screen.findByText("Roadmap")).toBeInTheDocument();
  });

  it("ignores a slow, now-stale search response that resolves after a newer one (NIL-323/NIL-345)", async () => {
    let resolveStale: (value: { results: ReturnType<typeof board>[]; totalCount: number }) => void;
    const stale = new Promise<{ results: ReturnType<typeof board>[]; totalCount: number }>(
      (resolve) => {
        resolveStale = resolve;
      },
    );
    search.mockImplementation(({ q }: { q: string }) => {
      if (q === "aaa") return stale;
      return Promise.resolve({
        results: [board({ id: "b2", name: "Fresher" })],
        totalCount: 1,
        limit: 8,
        offset: 0,
      });
    });

    render(<CommandPalette isOpen onClose={vi.fn()} />);
    const input = screen.getByPlaceholderText(/search boards/i);

    fireEvent.change(input, { target: { value: "aaa" } });
    await waitFor(() => expect(search).toHaveBeenCalledWith({ q: "aaa", limit: 8 }));

    fireEvent.change(input, { target: { value: "bbb" } });
    await waitFor(() => expect(search).toHaveBeenCalledWith({ q: "bbb", limit: 8 }));
    expect(await screen.findByText("Fresher")).toBeInTheDocument();

    // The slow "aaa" search finally resolves after "bbb" already rendered --
    // it must not overwrite the newer, already-displayed result.
    resolveStale!({
      results: [board({ id: "b1", name: "Stale" })],
      totalCount: 1,
      limit: 8,
      offset: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText("Stale")).not.toBeInTheDocument();
    expect(screen.getByText("Fresher")).toBeInTheDocument();
  });

  it("creates a new board and navigates into it", async () => {
    createDrawing.mockResolvedValue({ id: "new-board-1" });
    const onClose = vi.fn();
    render(<CommandPalette isOpen onClose={onClose} />);
    fireEvent.click(screen.getByText("New board"));
    await waitFor(() => expect(createDrawing).toHaveBeenCalledWith("Untitled Drawing", null));
    expect(navigate).toHaveBeenCalledWith("/editor/new-board-1");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("toasts an error and stays open when board creation fails", async () => {
    createDrawing.mockRejectedValue(new Error("boom"));
    const onClose = vi.fn();
    render(<CommandPalette isOpen onClose={onClose} />);
    fireEvent.click(screen.getByText("New board"));
    await waitFor(() => expect(notification).toHaveBeenCalledWith("error", expect.any(String)));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("drops into a name-entry sub-mode for New collection, then creates and navigates", async () => {
    createCollection.mockResolvedValue({ id: "col-1", name: "Q4" });
    const onClose = vi.fn();
    render(<CommandPalette isOpen onClose={onClose} />);
    fireEvent.click(screen.getByText("New collection"));

    const nameInput = screen.getByPlaceholderText("Collection name");
    expect(nameInput).toBeInTheDocument();
    // Static actions/search box are gone while naming.
    expect(screen.queryByPlaceholderText(/search boards/i)).not.toBeInTheDocument();

    fireEvent.change(nameInput, { target: { value: "Q4" } });
    fireEvent.keyDown(nameInput, { key: "Enter" });

    await waitFor(() => expect(createCollection).toHaveBeenCalledWith("Q4"));
    expect(navigate).toHaveBeenCalledWith("/collections?id=col-1");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not create a collection with a blank name", () => {
    render(<CommandPalette isOpen onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("New collection"));
    const nameInput = screen.getByPlaceholderText("Collection name");
    fireEvent.keyDown(nameInput, { key: "Enter" });
    expect(createCollection).not.toHaveBeenCalled();
  });

  it("Escape steps back from new-collection naming to the list, not a full close", () => {
    const onClose = vi.fn();
    render(<CommandPalette isOpen onClose={onClose} />);
    fireEvent.click(screen.getByText("New collection"));
    fireEvent.keyDown(screen.getByPlaceholderText("Collection name"), { key: "Escape" });

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText(/search boards/i)).toBeInTheDocument();
  });

  it("Escape from the list closes the palette", () => {
    const onClose = vi.fn();
    render(<CommandPalette isOpen onClose={onClose} />);
    fireEvent.keyDown(screen.getByPlaceholderText(/search boards/i), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes when the backdrop is clicked", () => {
    const onClose = vi.fn();
    render(<CommandPalette isOpen onClose={onClose} />);
    fireEvent.click(screen.getByTestId("command-palette-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("announces search status to screen readers via a live region (NIL-323/NIL-346)", async () => {
    search.mockResolvedValue({
      results: [board(), board({ id: "b2", name: "Retro" })],
      totalCount: 2,
      limit: 8,
      offset: 0,
    });
    render(<CommandPalette isOpen onClose={vi.fn()} />);
    const liveRegion = document.querySelector('[aria-live="polite"]')!;
    expect(liveRegion).toHaveTextContent("");

    fireEvent.change(screen.getByPlaceholderText(/search boards/i), {
      target: { value: "r" },
    });
    await waitFor(() => expect(liveRegion).toHaveTextContent("2 boards found"));
  });

  it("wraps Tab focus at the dialog boundary instead of leaking out to the page behind it (NIL-323/NIL-346)", async () => {
    // jsdom does not implement native Tab traversal (no @testing-library/
    // user-event here) -- this exercises the two boundary-wrap branches the
    // handler actually implements; a real browser's own default handling
    // covers ordinary forward/backward moves between stops in between.
    search.mockRejectedValue(new Error("network down"));
    render(<CommandPalette isOpen onClose={vi.fn()} />);
    const input = screen.getByPlaceholderText(/search boards/i);
    fireEvent.change(input, { target: { value: "road" } });
    const retryButton = await screen.findByText("Try again");

    // Tab forward from the last stop wraps to the first.
    retryButton.focus();
    fireEvent.keyDown(retryButton, { key: "Tab" });
    expect(document.activeElement).toBe(input);

    // Shift+Tab backward from the first stop wraps to the last.
    input.focus();
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(retryButton);
  });

  it("option rows are not real tab stops -- arrow-key virtual cursor only", () => {
    render(<CommandPalette isOpen onClose={vi.fn()} />);
    for (const button of screen.getAllByRole("option")) {
      expect(button).toHaveAttribute("tabindex", "-1");
    }
  });

  it("resets query, mode and highlight each time it reopens", () => {
    const { rerender } = render(<CommandPalette isOpen onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/search boards/i), {
      target: { value: "team" },
    });
    expect(screen.queryByText("New board")).not.toBeInTheDocument();

    rerender(<CommandPalette isOpen={false} onClose={vi.fn()} />);
    rerender(<CommandPalette isOpen onClose={vi.fn()} />);

    expect(screen.getByPlaceholderText(/search boards/i)).toHaveValue("");
    expect(screen.getByText("New board")).toBeInTheDocument();
  });
});
