import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import "./editorChrome.css";
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
  it("orders invite before share", () => {
    const ids = [...HEADER_CONTROL_ENTRIES].sort((a, b) => a.order - b.order).map((e) => e.id);
    expect(ids).toEqual(["invite-everyone-here", "share"]);
  });

  it("hides both controls under the conditions MainMenu also hides its own copies under", () => {
    const readOnlyEditor: ChromeSlotContext = { ...baseCtx, accessLevel: "edit", peers: [] };
    expect(renderedIds(HEADER_CONTROL_ENTRIES, readOnlyEditor)).toEqual([null, null]);
  });

  /**
   * Regression guard (PR #61 fix-push, then NIL-325 fix-push): a "comments"
   * HeaderControlSlotEntry, and separately this package's own "present" one,
   * were both here briefly. Measured against a real multi-collaborator
   * session, a third header-control icon (alongside invite/share) pushes
   * `.layer-ui__wrapper__top-right` past whatever width Excalidraw's own
   * collaborator-avatar list uses to decide between showing avatars and
   * collapsing to a "+N" badge -- collaboration.spec.ts's presence/sync/cursor
   * tests and follow-mode.spec.ts's avatar-click test both caught it losing
   * `.UserList__collaborator .Avatar` entirely, the second time by breaking
   * CI on a PR that had nothing else to do with follow or presence. Both
   * stay MAIN_MENU_ENTRIES-only entries (see chromeSlots.tsx's own comments
   * there); this asserts neither quietly comes back to the header group.
   */
  it("never re-adds a comments or present entry -- see the regression note above", () => {
    const ids = HEADER_CONTROL_ENTRIES.map((e) => e.id);
    expect(ids).not.toContain("comments");
    expect(ids).not.toContain("present");
  });

  /**
   * NIL-579: invite-everyone-here answers "who's here" (presence) and share
   * answers "what can I do" (actions) -- EditorTopRight.tsx's hairline
   * divider only sits correctly between the two calls to
   * `renderHeaderControlEntries(ctx, zone)` if each entry actually carries
   * the zone that matches the question it answers.
   */
  it("assigns invite-everyone-here to the presence zone and share to the actions zone", () => {
    const byId = Object.fromEntries(HEADER_CONTROL_ENTRIES.map((e) => [e.id, e.zone]));
    expect(byId["invite-everyone-here"]).toBe("presence");
    expect(byId["share"]).toBe("actions");
  });
});

describe("renderHeaderControlEntries with a zone filter (NIL-579)", () => {
  const withPeer: ChromeSlotContext = {
    ...baseCtx,
    accessLevel: "owner",
    canEdit: true,
    peers: [{ id: "p1" } as any],
  };

  it("renders only the presence entry for zone 'presence'", () => {
    const output = React.Children.toArray(
      renderHeaderControlEntries(withPeer, "presence"),
    ) as React.ReactElement[];
    const rendered = output
      .filter((el) => el.props.children != null)
      .map((el) => String(el.key).replace(/^\.\$/, ""));
    expect(rendered).toEqual(["invite-everyone-here"]);
  });

  it("renders only the actions entry for zone 'actions'", () => {
    const output = React.Children.toArray(
      renderHeaderControlEntries(withPeer, "actions"),
    ) as React.ReactElement[];
    const rendered = output
      .filter((el) => el.props.children != null)
      .map((el) => String(el.key).replace(/^\.\$/, ""));
    expect(rendered).toEqual(["share"]);
  });

  it("renders both when no zone is given, unchanged from before NIL-579", () => {
    const output = React.Children.toArray(
      renderHeaderControlEntries(withPeer),
    ) as React.ReactElement[];
    const rendered = output
      .filter((el) => el.props.children != null)
      .map((el) => String(el.key).replace(/^\.\$/, ""));
    expect(rendered).toEqual(["invite-everyone-here", "share"]);
  });
});

describe("renderHeaderControlEntries", () => {
  it("renders nothing when no control applies", () => {
    const viewer: ChromeSlotContext = {
      ...baseCtx,
      accessLevel: "view",
      canEdit: false,
      peers: [],
    };
    const output = React.Children.toArray(
      renderHeaderControlEntries(viewer),
    ) as React.ReactElement[];
    expect(output.every((el) => el.props.children == null)).toBe(true);
  });
});

describe("the visible top-right wrapper", () => {
  it("does not paint Excalidraw's wrapper when it has no children", () => {
    const { rerender } = render(
      <div className="excalidraw">
        <div className="layer-ui__wrapper__top-right" data-testid="top-right-wrapper" />
      </div>,
    );
    const wrapper = screen.getByTestId("top-right-wrapper");
    expect(getComputedStyle(wrapper).display).toBe("none");

    rerender(
      <div className="excalidraw">
        <div className="layer-ui__wrapper__top-right" data-testid="top-right-wrapper">
          <button type="button">Share</button>
        </div>
      </div>,
    );
    expect(getComputedStyle(screen.getByTestId("top-right-wrapper")).display).toBe("flex");
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
