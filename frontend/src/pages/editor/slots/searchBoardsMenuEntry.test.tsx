import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SearchBoardsMenuEntry } from "./searchBoardsMenuEntry";

const { open } = vi.hoisted(() => ({ open: vi.fn() }));

vi.mock("../../../context/CommandPaletteContext", () => ({
  useCommandPalette: () => ({ open, close: vi.fn(), isOpen: false }),
}));

describe("SearchBoardsMenuEntry", () => {
  it("opens the command palette when selected", () => {
    render(<SearchBoardsMenuEntry />);
    fireEvent.click(screen.getByText("Search boards"));
    expect(open).toHaveBeenCalledTimes(1);
  });
});
