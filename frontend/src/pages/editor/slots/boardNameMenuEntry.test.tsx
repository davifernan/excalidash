import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BoardNameMenuEntry } from "./boardNameMenuEntry";
import type { ChromeSlotContext } from "../chromeSlots";

const baseCtx: ChromeSlotContext = {
  id: "drawing-1",
  accessLevel: "owner",
  canEdit: true,
  mobile: false,
  drawingName: "Sprint Retro",
  isRenaming: false,
  isSavingOnLeave: false,
  newName: "",
  peers: [],
  followers: [],
  inviteHere: {
    invitation: null,
    status: null,
    invite: vi.fn(),
    accept: vi.fn(),
    decline: vi.fn(),
  },
  langCode: "en",
  onBackClick: vi.fn(),
  onNewNameChange: vi.fn(),
  onRenameBlur: vi.fn(),
  onRenameStart: vi.fn(),
  onRenameSubmit: vi.fn(),
  onExportClick: vi.fn(),
  onShareOpen: vi.fn(),
  onHistoryOpen: vi.fn(),
  onSetLangCode: vi.fn(),
};

describe("BoardNameMenuEntry", () => {
  it("shows the drawing name when not renaming", () => {
    render(<BoardNameMenuEntry ctx={baseCtx} />);
    expect(screen.getByTestId("menu-board-name")).toHaveTextContent("Sprint Retro");
    expect(screen.queryByLabelText("Drawing name")).not.toBeInTheDocument();
  });

  it("starts a rename on double-click when editable", () => {
    const onRenameStart = vi.fn();
    render(<BoardNameMenuEntry ctx={{ ...baseCtx, onRenameStart }} />);
    fireEvent.doubleClick(screen.getByTestId("menu-board-name"));
    expect(onRenameStart).toHaveBeenCalledTimes(1);
  });

  it("does not start a rename on double-click for a read-only visitor", () => {
    const onRenameStart = vi.fn();
    render(<BoardNameMenuEntry ctx={{ ...baseCtx, canEdit: false, onRenameStart }} />);
    fireEvent.doubleClick(screen.getByTestId("menu-board-name"));
    expect(onRenameStart).not.toHaveBeenCalled();
  });

  it("marks a read-only board", () => {
    render(<BoardNameMenuEntry ctx={{ ...baseCtx, canEdit: false }} />);
    expect(screen.getByText("Read-only")).toBeInTheDocument();
  });

  it("shows an editable input while renaming, seeded with the pending name", () => {
    render(<BoardNameMenuEntry ctx={{ ...baseCtx, isRenaming: true, newName: "New Name" }} />);
    const input = screen.getByLabelText("Drawing name") as HTMLInputElement;
    expect(input.value).toBe("New Name");
    expect(screen.queryByTestId("menu-board-name")).not.toBeInTheDocument();
  });

  it("reports every keystroke and the eventual submit", () => {
    const onNewNameChange = vi.fn();
    const onRenameSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    render(
      <BoardNameMenuEntry
        ctx={{ ...baseCtx, isRenaming: true, newName: "Sprint", onNewNameChange, onRenameSubmit }}
      />,
    );
    const input = screen.getByLabelText("Drawing name");
    fireEvent.change(input, { target: { value: "Sprint Retro 2" } });
    expect(onNewNameChange).toHaveBeenCalledWith("Sprint Retro 2");
    fireEvent.submit(input.closest("form")!);
    expect(onRenameSubmit).toHaveBeenCalledTimes(1);
  });

  it("submits the rename on blur, same as the island it replaced", () => {
    const onRenameBlur = vi.fn();
    render(<BoardNameMenuEntry ctx={{ ...baseCtx, isRenaming: true, onRenameBlur }} />);
    fireEvent.blur(screen.getByLabelText("Drawing name"));
    expect(onRenameBlur).toHaveBeenCalledTimes(1);
  });
});
