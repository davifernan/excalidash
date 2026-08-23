import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceContextMenuEntry } from "./workspaceContextMenuEntry";
import type { ChromeSlotContext } from "../chromeSlots";

const baseCtx: ChromeSlotContext = {
  id: "drawing-1",
  accessLevel: "owner",
  canEdit: true,
  mobile: false,
  drawingName: "Sprint Retro",
  collectionId: null,
  collectionName: null,
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

describe("WorkspaceContextMenuEntry", () => {
  it("shows the collection name when the board has one", () => {
    render(
      <WorkspaceContextMenuEntry
        ctx={{ ...baseCtx, collectionId: "c1", collectionName: "Roadmap" }}
      />,
    );
    expect(screen.getByTestId("menu-workspace-context")).toHaveTextContent("Roadmap");
  });

  it("renders nothing for an unorganized board", () => {
    render(<WorkspaceContextMenuEntry ctx={baseCtx} />);
    expect(screen.queryByTestId("menu-workspace-context")).not.toBeInTheDocument();
  });

  it("renders nothing when only one of collectionId/collectionName is present (a partial answer is not a real one)", () => {
    render(
      <WorkspaceContextMenuEntry ctx={{ ...baseCtx, collectionId: "c1", collectionName: null }} />,
    );
    expect(screen.queryByTestId("menu-workspace-context")).not.toBeInTheDocument();
  });
});
