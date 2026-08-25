import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "./editorChrome.css";
import { EditorTopRight } from "./EditorTopRight";
import type { ChromeSlotContext } from "./chromeSlots";

const baseCtx: ChromeSlotContext = {
  id: "drawing-1",
  accessLevel: "owner",
  canEdit: true,
  mobile: false,
  drawingName: "Untitled",
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
  isCommentsOpen: false,
  unresolvedCommentCount: 0,
  presenting: {
    status: "idle",
    isSelf: false,
    presenterName: null,
    start: vi.fn(),
    stop: vi.fn(),
  },
  onStartVoteCompose: vi.fn(),
  onInsertTemplate: vi.fn(),
  onBackClick: vi.fn(),
  onNewNameChange: vi.fn(),
  onRenameBlur: vi.fn(),
  onRenameStart: vi.fn(),
  onRenameSubmit: vi.fn(),
  onExportClick: vi.fn(),
  onShareOpen: vi.fn(),
  onHistoryOpen: vi.fn(),
  onSetLangCode: vi.fn(),
  onToggleComments: vi.fn(),
} as unknown as ChromeSlotContext;

/**
 * NIL-579's own Nachweispflicht: "a test proving that without peers, neither
 * the presence zone nor the hairline occupies width -- measured width, not a
 * visibility flag." `queryByTestId` returning `null` means the divider is
 * absent from the DOM entirely (not merely hidden via CSS), so it cannot
 * contribute to the parent's flex `gap` -- the same class of bug NIL-564
 * fixed for the outer wrapper. The real-browser `boundingBox()` measurement
 * of the same before/after transition lives in
 * e2e/tests/canvas-chrome.spec.ts.
 */
describe("EditorTopRight zone divider (NIL-579)", () => {
  it("renders no divider, and no presence-zone entry, without peers", () => {
    render(<EditorTopRight isMobile={false} followerNotice={null} ctx={baseCtx} />);
    expect(screen.queryByTestId("editor-zone-divider")).toBeNull();
    expect(screen.queryByTestId("editor-invite")).toBeNull();
    expect(screen.getByTestId("editor-share")).toBeInTheDocument();
  });

  it("renders the divider once a peer makes the presence zone non-empty", () => {
    const withPeer: ChromeSlotContext = { ...baseCtx, peers: [{ id: "p1" } as any] };
    render(<EditorTopRight isMobile={false} followerNotice={null} ctx={withPeer} />);
    expect(screen.getByTestId("editor-zone-divider")).toBeInTheDocument();
    expect(screen.getByTestId("editor-invite")).toBeInTheDocument();
  });

  it("renders nothing at all on mobile, divider included", () => {
    const withPeer: ChromeSlotContext = { ...baseCtx, peers: [{ id: "p1" } as any] };
    const { container } = render(
      <EditorTopRight isMobile={true} followerNotice={null} ctx={withPeer} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
