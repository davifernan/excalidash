import React from "react";
import { describe, expect, it, vi } from "vitest";
import {
  FOOTER_ENTRIES,
  HEADER_CONTROL_ENTRIES,
  MAIN_MENU_ENTRIES,
  followerNotice,
  renderFooterEntries,
  renderHeaderControlEntries,
  renderMainMenuEntries,
  type ChromeSlotContext,
} from "./chromeSlots";

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

/** Render functions return element descriptors without mounting -- Excalidraw's
 * own MainMenu hooks only run on actual DOM reconciliation, so calling
 * `entry.render(ctx)` directly is enough to test ordering and conditional
 * visibility without a `<Excalidraw>` provider tree. */
const renderedIds = (
  entries: typeof MAIN_MENU_ENTRIES,
  ctx: ChromeSlotContext,
): (string | null)[] =>
  [...entries]
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map((entry) => (entry.render(ctx) === null ? null : entry.id));

describe("MAIN_MENU_ENTRIES", () => {
  it("puts the board name first and Help last, in ascending order", () => {
    const ids = renderedIds(MAIN_MENU_ENTRIES, baseCtx).filter(Boolean);
    expect(ids[0]).toBe("board-name");
    expect(ids[ids.length - 1]).toBe("help");
  });

  it("places back-to-dashboard directly after the board name when there is no workspace context to show (NIL-374)", () => {
    const ids = renderedIds(MAIN_MENU_ENTRIES, baseCtx).filter(Boolean);
    const nameIdx = ids.indexOf("board-name");
    expect(ids[nameIdx + 1]).toBe("back-to-dashboard");
  });

  it("slots workspace-context between board-name and back-to-dashboard when the board has a collection (NIL-323/NIL-344)", () => {
    const inCollection: ChromeSlotContext = {
      ...baseCtx,
      collectionId: "c1",
      collectionName: "Roadmap",
    };
    const ids = renderedIds(MAIN_MENU_ENTRIES, inCollection).filter(Boolean);
    expect(ids.slice(ids.indexOf("board-name"), ids.indexOf("board-name") + 3)).toEqual([
      "board-name",
      "workspace-context",
      "back-to-dashboard",
    ]);
  });

  it("hides workspace-context for an unorganized board or a viewer the backend never sent collection data to", () => {
    expect(renderedIds(MAIN_MENU_ENTRIES, baseCtx)).not.toContain("workspace-context");
    const partial: ChromeSlotContext = { ...baseCtx, collectionId: "c1", collectionName: null };
    expect(renderedIds(MAIN_MENU_ENTRIES, partial)).not.toContain("workspace-context");
  });

  it("hides version history for a read-only visitor", () => {
    const readOnly: ChromeSlotContext = { ...baseCtx, canEdit: false };
    expect(renderedIds(MAIN_MENU_ENTRIES, readOnly)).not.toContain("version-history");
    expect(renderedIds(MAIN_MENU_ENTRIES, baseCtx)).toContain("version-history");
  });

  it("hides Share unless the viewer owns the drawing", () => {
    const editor: ChromeSlotContext = { ...baseCtx, accessLevel: "edit" };
    expect(renderedIds(MAIN_MENU_ENTRIES, editor)).not.toContain("share");
    expect(renderedIds(MAIN_MENU_ENTRIES, baseCtx)).toContain("share");
  });

  it("hides invite-everyone-here when nobody else is on the board", () => {
    expect(renderedIds(MAIN_MENU_ENTRIES, baseCtx)).not.toContain("invite-everyone-here");
    const withPeer: ChromeSlotContext = { ...baseCtx, peers: [{ id: "p1" } as any] };
    expect(renderedIds(MAIN_MENU_ENTRIES, withPeer)).toContain("invite-everyone-here");
  });

  it("always renders the board name, editable or not", () => {
    const readOnly: ChromeSlotContext = { ...baseCtx, canEdit: false };
    expect(renderedIds(MAIN_MENU_ENTRIES, baseCtx)).toContain("board-name");
    expect(renderedIds(MAIN_MENU_ENTRIES, readOnly)).toContain("board-name");
  });

  it("puts search-boards right after back-to-dashboard, for anyone (NIL-323/NIL-345)", () => {
    const ids = renderedIds(MAIN_MENU_ENTRIES, baseCtx).filter(Boolean);
    const backIdx = ids.indexOf("back-to-dashboard");
    expect(ids[backIdx + 1]).toBe("search-boards");
    const readOnly: ChromeSlotContext = { ...baseCtx, canEdit: false, accessLevel: "view" };
    expect(renderedIds(MAIN_MENU_ENTRIES, readOnly)).toContain("search-boards");
  });
});

describe("renderMainMenuEntries", () => {
  it("emits one keyed fragment per entry, in the same order as the sorted registry", () => {
    const expectedOrder = [...MAIN_MENU_ENTRIES]
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
      .map((entry) => entry.id);
    const output = React.Children.toArray(renderMainMenuEntries(baseCtx)) as React.ReactElement[];
    // React.Children.toArray prefixes keys with ".$"; strip it back off.
    expect(output.map((el) => String(el.key).replace(/^\.\$/, ""))).toEqual(expectedOrder);
  });
});

describe("HEADER_CONTROL_ENTRIES", () => {
  it("orders invite before share", () => {
    const ids = [...HEADER_CONTROL_ENTRIES].sort((a, b) => a.order - b.order).map((e) => e.id);
    expect(ids).toEqual(["invite-everyone-here", "share"]);
  });

  it("hides both controls under the conditions MainMenu also hides its own copies under", () => {
    const readOnlyEditor: ChromeSlotContext = { ...baseCtx, accessLevel: "edit", peers: [] };
    expect(renderedIds(HEADER_CONTROL_ENTRIES, readOnlyEditor)).toEqual([null, null]);
  });
});

describe("renderHeaderControlEntries", () => {
  it("renders nothing when neither control applies", () => {
    const alone: ChromeSlotContext = { ...baseCtx, accessLevel: "edit", peers: [] };
    const output = React.Children.toArray(
      renderHeaderControlEntries(alone),
    ) as React.ReactElement[];
    expect(output.every((el) => el.props.children == null)).toBe(true);
  });
});

describe("the Footer slot -- an empty slot, deliberately (NIL-376)", () => {
  it("ships with zero entries: the workshop timer moved to the overlay instead", () => {
    expect(FOOTER_ENTRIES).toEqual([]);
  });

  it("renders nothing at all rather than an empty Footer wrapper", () => {
    expect(renderFooterEntries(baseCtx)).toBeNull();
  });
});

describe("followerNotice", () => {
  it("says nothing for zero followers", () => {
    expect(followerNotice([])).toBeNull();
  });

  it("names the one follower", () => {
    expect(followerNotice([{ name: "Ada" } as any])).toBe("Ada is following you");
  });

  it("counts followers once there is more than one", () => {
    expect(followerNotice([{ name: "Ada" } as any, { name: "Grace" } as any])).toBe(
      "2 people are following you",
    );
  });
});
