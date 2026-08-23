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

  it("places back-to-dashboard directly after the board name (NIL-374)", () => {
    const ids = renderedIds(MAIN_MENU_ENTRIES, baseCtx).filter(Boolean);
    const nameIdx = ids.indexOf("board-name");
    expect(ids[nameIdx + 1]).toBe("back-to-dashboard");
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

  it("shows comments for any real access level, hides it once access is none", () => {
    const viewOnly: ChromeSlotContext = { ...baseCtx, accessLevel: "view", canEdit: false };
    const noAccess: ChromeSlotContext = { ...baseCtx, accessLevel: "none", id: undefined };
    expect(renderedIds(MAIN_MENU_ENTRIES, viewOnly)).toContain("comments");
    expect(renderedIds(MAIN_MENU_ENTRIES, noAccess)).not.toContain("comments");
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
  it("orders invite, then comments, then share", () => {
    const ids = [...HEADER_CONTROL_ENTRIES].sort((a, b) => a.order - b.order).map((e) => e.id);
    expect(ids).toEqual(["invite-everyone-here", "comments", "share"]);
  });

  it("hides invite and share under the conditions MainMenu also hides its own copies under -- comments has its own, broader condition", () => {
    const readOnlyEditor: ChromeSlotContext = { ...baseCtx, accessLevel: "edit", peers: [] };
    // Comments is not gated on peers (unlike invite) or ownership (unlike
    // share): any account with real access to the board may open the panel
    // alone, so it renders here where the other two do not.
    expect(renderedIds(HEADER_CONTROL_ENTRIES, readOnlyEditor)).toEqual([null, "comments", null]);
  });

  it("hides comments too once there is no real access at all", () => {
    const noAccess: ChromeSlotContext = { ...baseCtx, accessLevel: "none" };
    expect(renderedIds(HEADER_CONTROL_ENTRIES, noAccess)).toEqual([null, null, null]);
  });
});

describe("renderHeaderControlEntries", () => {
  it("renders nothing when no control applies", () => {
    const noAccess: ChromeSlotContext = { ...baseCtx, accessLevel: "none", peers: [] };
    const output = React.Children.toArray(
      renderHeaderControlEntries(noAccess),
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
