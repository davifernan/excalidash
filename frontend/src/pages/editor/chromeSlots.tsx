/**
 * The canvas chrome slot contract.
 *
 * NIL-376: EditorView.tsx used to be the one JSX block every chrome
 * contributor edited -- MainMenu, the top-right cluster and the footer were
 * all inline there. Four packages want to add an entry point to that same
 * block (board/team context, comments, presenting, this package's own board
 * name and back route), and a shared JSX block edited by four packages is a
 * merge conflict generator, not a coincidence. This file is the seam: a
 * package adds a slot *entry* here, EditorView.tsx renders whatever this file
 * hands it, and stays unedited for every entry added after this one.
 *
 * ## The places
 *
 * - **Hamburger entry** (`MainMenuSlotEntry`) -- a row in Excalidraw's own
 *   MainMenu, portalled through `EditorMenu` (slots.tsx). Exists on every
 *   layout, including mobile.
 * - **Header control** (`HeaderControlSlotEntry`) -- an icon button in the
 *   top-right grey control group (EditorTopRight.tsx), flush with Excalidraw's
 *   own collaborator avatars and Library trigger. Hidden entirely on mobile
 *   (EditorTopRight stands down there). A header entry does not implicitly
 *   create a duplicate mobile menu route; a feature that must survive mobile
 *   adds a deliberate menu or overlay entry of its own.
 *
 *   This slot has a factual upper limit: a third icon here, alongside
 *   invite-everyone-here and share, pushes `.layer-ui__wrapper__top-right`
 *   past the width where Excalidraw's own collaborator-avatar list collapses
 *   individual avatars into a "+N" badge. Whoever triggers this does not see
 *   it at their own entry -- they see collaboration.spec.ts's presence, sync,
 *   and cursor tests lose the `.UserList__collaborator .Avatar` node, or
 *   follow-mode.spec.ts's avatar-click test with it. Two packages hit this
 *   independently as a full third header-control entry -- a "comments" one
 *   (PR #61) and this package's own "present" one (PR #65) -- each first
 *   read as an unrelated regression in someone else's spec before being
 *   traced back here. The way out is the same one Mobile (below) already
 *   uses: a MainMenu entry or an overlay instead of a header control, once
 *   this group is full.
 * - **Footer** (`FooterSlotEntry`) -- Excalidraw's Footer tunnel, which mounts
 *   only on desktop; Excalidraw renders no Footer at all on the mobile
 *   layout. A footer entry that also needs to exist on mobile has to bring
 *   its own overlay fallback, the way the workshop timer now does through
 *   `ui.overlayRoot()` instead of the footer at all (WorkshopTimerCorner.tsx)
 *   -- which is also this contract's demonstration of the empty-slot case
 *   below.
 * - **Overlay** (`OverlaySlotEntry`) -- a portal into `ui.overlayRoot()`, the
 *   Excalidraw-root DOM node. Free-floating, self-positioned, on every
 *   layout. No `order`: overlays do not share a flow, each manages its own
 *   position and stacking.
 *
 * ## Order
 *
 * `MainMenuSlotEntry` and `HeaderControlSlotEntry` carry a numeric `order`,
 * ascending, rendered low-to-high. This package's own entries sit on
 * multiples of 10 with gaps left between them; pick a value near the entry
 * you sit beside and say why in your slot module's own comment, the way
 * `boardNameMenuEntry.tsx` and the entries below do. Ties break by ascending
 * `id`. `OverlaySlotEntry` has no `order` for the reason above.
 *
 * ## An empty slot
 *
 * Nothing is reserved for a slot with zero entries. `renderFooterEntries`
 * returns `null` when the array is empty, and EditorView.tsx does not render
 * `<Footer>` at all in that case -- Excalidraw's own footer-left (zoom/undo)
 * stays, nothing else does. That is the current state of the Footer slot in
 * this PR: the workshop timer used to live there and now lives in the
 * overlay instead, so the Footer slot ships empty. No stray flex gap, no
 * empty grey box.
 *
 * ## Mobile
 *
 * The MainMenu slot is the one place that exists at every window size, which
 * is why the board name and the way back both live there rather than in a
 * floating island: an island is exactly the thing this package removes.
 * Header controls disappear entirely on mobile (EditorTopRight returns null);
 * an entry that must survive there belongs in the menu or in an overlay, not
 * the header control slot. Overlay entries are on their own to stay usable at
 * every width -- WorkshopTimerCorner clamps against the live container size
 * for exactly this reason.
 *
 * ## Growing the context (NIL-323/NIL-344)
 *
 * `ChromeSlotContext` is shared infrastructure now, not one package's file:
 * #59 (NIL-376) merged and its slot contract is done, so a package that
 * needs a field it does not carry yet adds the field here rather than
 * fetching the data a second way from inside its own slot component --
 * the same rule as a missing capability in capabilities.ts. Ground rules,
 * so the next addition does not have to guess whether its case qualifies:
 *
 * - **Additive only.** Add a field; never rename or restructure an existing
 *   one. `ChromeSlotContext` is consumed by every registered entry across
 *   every package that has one, so a rename is the same shared-file
 *   conflict this contract exists to avoid.
 * - **Same gate as the backend, not a new one.** `collectionId` and
 *   `collectionName` (added by NIL-323/NIL-344, for the board/team context
 *   entry) carry exactly the visibility rule `drawingReadRoutes.ts`
 *   already enforces for `collectionId` -- both `null` for anyone who is
 *   not the board's creator. A slot field is not the place to invent a
 *   second, looser access rule for data a route already decided how to
 *   gate.
 * - **Say why here.** NIL-324 (comment entry point) and NIL-372
 *   (follow/follower display) are expected to read from this same object
 *   next; this section exists so whoever adds the next field can see what
 *   was decided and why, instead of re-deriving it.
 */
import React from "react";
import {
  ArrowLeft,
  Download,
  FileInput,
  GitBranch,
  History,
  LayoutTemplate,
  LocateFixed,
  MessageSquare,
  Play,
  Share2,
  Square,
  Vote,
} from "lucide-react";
import {
  EditorFooter as Footer,
  EditorMenu as MainMenu,
} from "../../integrations/excalidraw/slots";
import { LanguageSelector } from "../../components/LanguageSelector";
import { BoardNameMenuEntry } from "./slots/boardNameMenuEntry";
import { WorkspaceContextMenuEntry } from "./slots/workspaceContextMenuEntry";
import { SearchBoardsMenuEntry } from "./slots/searchBoardsMenuEntry";
import { CommentsMenuEntry } from "./slots/commentsMenuEntry";
import type { InviteHereUiState } from "./InviteHereOverlay";
import type { Follower } from "./followMode";
import type { Peer } from "./useEditorCollaboration";
import type { PresenterStatus } from "./presenterMode";
import { WORKSHOP_TEMPLATES } from "./workshopTemplates";

export type ChromeSlotContext = {
  id?: string;
  accessLevel: "none" | "view" | "comment" | "edit" | "owner";
  canEdit: boolean;
  mobile: boolean;
  drawingName: string;
  /** Which collection this board sits in, or null (unorganized, or hidden -- see "Growing the context" above). */
  collectionId: string | null;
  collectionName: string | null;
  isRenaming: boolean;
  isSavingOnLeave: boolean;
  newName: string;
  peers: readonly Peer[];
  followers: readonly Follower[];
  inviteHere: InviteHereUiState;
  langCode: string;
  isCommentsOpen: boolean;
  unresolvedCommentCount: number;
  /**
   * Just enough for the entry point's label and click handler -- the full
   * server-authoritative state lives in `PresentationOverlay`'s own props.
   * NIL-325.
   */
  presenting: {
    status: PresenterStatus;
    isSelf: boolean;
    presenterName: string | null;
    start: () => void;
    stop: () => void;
  };
  onStartVoteCompose: () => void;
  onInsertTemplate: (templateId: string) => void;
  /** NIL-593: run the ambient tree's one explicit layout pass, rooted at
   *  the current selection. See `frontend/src/mindMap/index.tsx`. */
  onArrangeMindMap: () => void;
  /** NIL-572/593: open the paste/preview import dialog. See `frontend/src/mindMap/index.tsx`. */
  onOpenMindMapImport: () => void;
  onBackClick: () => void;
  onNewNameChange: (value: string) => void;
  onRenameBlur: () => void;
  onRenameStart: () => void;
  onRenameSubmit: (event: React.FormEvent) => void;
  onExportClick: () => void;
  onShareOpen: () => void;
  onHistoryOpen: () => void;
  onSetLangCode: (langCode: string) => void;
  onToggleComments: () => void;
};

type SlotEntry = {
  id: string;
  order: number;
  render: (ctx: ChromeSlotContext) => React.ReactNode;
};

export type MainMenuSlotEntry = SlotEntry;
/**
 * `zone` is NIL-579: the header-control group reads as two kinds of thing,
 * not one undifferentiated row -- presence (who's here) and actions (what
 * can I do). `EditorTopRight.tsx` renders presence entries, then a hairline
 * divider gated on `ctx.peers.length > 0` (the same truth that decides
 * whether Excalidraw's own avatar list is non-empty), then action entries.
 * A new header-control entry picks the zone that answers which of those two
 * questions it is -- not which one has room.
 */
export type HeaderControlSlotEntry = SlotEntry & { zone: "presence" | "actions" };
export type FooterSlotEntry = SlotEntry;
export type OverlaySlotEntry = { id: string; render: (ctx: ChromeSlotContext) => React.ReactNode };

const byOrder = (a: SlotEntry, b: SlotEntry) => a.order - b.order || a.id.localeCompare(b.id);

const canShareFromMobileMenu = (ctx: ChromeSlotContext): boolean =>
  ctx.mobile && ctx.accessLevel === "owner" && Boolean(ctx.id);

const canInviteFromMobileMenu = (ctx: ChromeSlotContext): boolean =>
  ctx.mobile && ctx.canEdit && ctx.peers.length > 0;

const describeFollowers = (followers: readonly Follower[]): string | null => {
  if (followers.length === 0) return null;
  if (followers.length === 1) return `${followers[0].name} is following you`;
  return `${followers.length} people are following you`;
};

/**
 * The hamburger, top to bottom. Order 10-25 is the lead-in (board name, the
 * board's workspace context, back route); everything from 100 on is what
 * already lived in the menu, renumbered with gaps so a later package can
 * slot something between two existing entries without renumbering the rest
 * -- workspace-context (order 15, NIL-323/NIL-344) is exactly that: slotted
 * between board-name and back-to-dashboard without moving either.
 *
 * workspace-context sits ABOVE back-to-dashboard on purpose, not just
 * because order 15 fell between 10 and 20: the lead-in reads as a
 * breadcrumb -- board name, then which collection it lives in, then the
 * navigation actions that leave the board. Context belongs with the
 * identity it describes, before the actions, the same order a page title
 * and its breadcrumb trail would read in any other part of the app. If a
 * future package wants navigation actions to lead instead, that is a
 * deliberate reordering to argue for here, not an accident to route around
 * in a test.
 *
 * search-boards (order 22, NIL-323/NIL-345) sits right after
 * back-to-dashboard for the same "leave this board" reason: both are
 * navigation, so they sit together ahead of the separator rather than
 * down with the canvas actions.
 *
 * This ordering is a registry, not a fixed list -- a test asserting an
 * entry's exact index (`menuItems.nth(1)`) breaks on every legitimate
 * insertion, which is the whole reason this file exists. Assert relative
 * order between two testids (or their presence) instead; see
 * `e2e/tests/canvas-chrome.spec.ts`'s "back to dashboard" test for the
 * pattern, and `menu-back-to-dashboard`/`menu-search-boards`/
 * `menu-board-name`/`menu-workspace-context`'s `data-testid`s below for the
 * hooks to assert against.
 *
 * Help sits last on purpose (NIL-374): Excalidraw's own floating "?" is
 * hidden in editorChrome.css, so this is the only way to it.
 */
export const MAIN_MENU_ENTRIES: MainMenuSlotEntry[] = [
  {
    id: "board-name",
    order: 10,
    render: (ctx) => (
      <MainMenu.ItemCustom>
        <BoardNameMenuEntry ctx={ctx} />
      </MainMenu.ItemCustom>
    ),
  },
  {
    id: "workspace-context",
    order: 15,
    // Checked here, not only inside the component: `renderedIds`-style
    // null-detection (used by this file's own tests, and by any future
    // slot inspecting what actually rendered) looks at what `render`
    // returns, not what a child component nested inside it decides. A
    // render that always returns `<MainMenu.ItemCustom>` and lets the
    // child go empty would report "rendered" even when nothing showed.
    render: (ctx) =>
      ctx.collectionId && ctx.collectionName ? (
        <MainMenu.ItemCustom>
          <WorkspaceContextMenuEntry ctx={ctx} />
        </MainMenu.ItemCustom>
      ) : null,
  },
  {
    id: "back-to-dashboard",
    order: 20,
    render: (ctx) => (
      <MainMenu.Item
        onSelect={ctx.onBackClick}
        icon={<ArrowLeft size={16} />}
        data-testid="menu-back-to-dashboard"
      >
        Back to dashboard
      </MainMenu.Item>
    ),
  },
  {
    id: "search-boards",
    order: 22,
    render: () => <SearchBoardsMenuEntry />,
  },
  { id: "lead-in-separator", order: 25, render: () => <MainMenu.Separator /> },
  { id: "toggle-theme", order: 100, render: () => <MainMenu.DefaultItems.ToggleTheme /> },
  {
    id: "command-palette",
    order: 105,
    // Supplying any custom MainMenu children disables Excalidraw's fallback
    // menu wholesale. Native entries therefore have to be passed through
    // here explicitly; omitting this one made the command palette (and its
    // grid toggle) unreachable from the menu even though Excalidraw exports
    // the complete implementation for embedders.
    render: () => <MainMenu.DefaultItems.CommandPalette />,
  },
  {
    id: "search-menu",
    order: 107,
    // The same fallback-replacement audit that found CommandPalette also
    // found Excalidraw's canvas search missing. Keep both native capabilities
    // at the adapter seam instead of rebuilding either command locally.
    render: () => <MainMenu.DefaultItems.SearchMenu />,
  },
  { id: "save-as-image", order: 110, render: () => <MainMenu.DefaultItems.SaveAsImage /> },
  {
    id: "export",
    order: 120,
    render: (ctx) => (
      <MainMenu.Item onSelect={ctx.onExportClick} icon={<Download size={16} />}>
        Export drawing
      </MainMenu.Item>
    ),
  },
  {
    id: "version-history",
    order: 130,
    render: (ctx) =>
      ctx.canEdit && ctx.id ? (
        <MainMenu.Item onSelect={ctx.onHistoryOpen} icon={<History size={16} />}>
          Version history
        </MainMenu.Item>
      ) : null,
  },
  {
    id: "comments",
    order: 140,
    // Grouped with export/version-history (content actions on the board)
    // rather than under collab-separator with share/invite: opening the
    // panel does not invite or hand anyone access, it just annotates.
    //
    // Menu-only, no HeaderControlSlotEntry: measured against a real
    // multi-collaborator session, a third icon in the header-control group
    // (alongside invite/share) pushes `.layer-ui__wrapper__top-right` past
    // whatever width Excalidraw's own collaborator-avatar list uses to
    // decide between showing avatars and collapsing to a "+N" badge --
    // `collaboration.spec.ts`'s presence/sync/cursor tests caught this by
    // losing the individual `.UserList__collaborator .Avatar` node entirely.
    // The file comment's own "Mobile" section already establishes this
    // path (menu or overlay, not the header control slot) for an entry that
    // cannot fit there; this is that case on desktop too, not only mobile.
    render: (ctx) =>
      ctx.accessLevel !== "none" && ctx.id ? (
        <MainMenu.Item onSelect={ctx.onToggleComments} icon={<MessageSquare size={16} />}>
          <CommentsMenuEntry ctx={ctx} />
        </MainMenu.Item>
      ) : null,
  },
  {
    id: "mobile-collaboration-separator",
    order: 195,
    // Desktop owns these actions in EditorTopRight. That component returns
    // null on mobile, so the separator and both routes exist only when at
    // least one mobile fallback action actually follows it.
    render: (ctx) =>
      canShareFromMobileMenu(ctx) || canInviteFromMobileMenu(ctx) ? <MainMenu.Separator /> : null,
  },
  {
    id: "share",
    order: 200,
    render: (ctx) =>
      canShareFromMobileMenu(ctx) ? (
        <MainMenu.Item onSelect={ctx.onShareOpen} icon={<Share2 size={16} />}>
          Share
        </MainMenu.Item>
      ) : null,
  },
  {
    id: "invite-everyone-here",
    order: 210,
    // Temporary bridge, not a second implementation: mobile has no
    // EditorTopRight, and this invokes the exact same invite action as the
    // desktop header entry. A dedicated mobile surface belongs to its own
    // package; until then removal here would make the feature unreachable.
    render: (ctx) =>
      canInviteFromMobileMenu(ctx) ? (
        <MainMenu.Item onSelect={ctx.inviteHere.invite} icon={<LocateFixed size={16} />}>
          Invite everyone here
        </MainMenu.Item>
      ) : null,
  },
  { id: "workshop-separator", order: 220, render: () => <MainMenu.Separator /> },
  {
    id: "present",
    order: 225,
    // Menu-only, no HeaderControlSlotEntry -- the same measured collision
    // that reverted the "comments" header icon (see this file's regression
    // note in HEADER_CONTROL_ENTRIES) applies here unchanged: a third icon
    // alongside invite/share pushes `.layer-ui__wrapper__top-right` past the
    // width Excalidraw's own collaborator-avatar list uses to decide between
    // showing avatars and collapsing to a "+N" badge, which broke
    // `collaboration.spec.ts`'s `.UserList__collaborator .Avatar` count
    // assertions and `follow-mode.spec.ts`'s avatar-click test the same way
    // it broke them for comments. Confirmed by removing this package's own
    // header button and watching both specs pass again.
    render: (ctx) =>
      ctx.canEdit ? (
        <MainMenu.Item
          onSelect={ctx.presenting.isSelf ? ctx.presenting.stop : ctx.presenting.start}
          icon={ctx.presenting.isSelf ? <Square size={16} /> : <Play size={16} />}
          data-testid="menu-present"
        >
          {ctx.presenting.isSelf
            ? "Stop presenting"
            : ctx.presenting.status === "presenting"
              ? `${ctx.presenting.presenterName || "Someone"} is presenting`
              : "Present"}
        </MainMenu.Item>
      ) : null,
  },
  {
    id: "start-a-vote",
    order: 230,
    render: (ctx) =>
      ctx.canEdit ? (
        <MainMenu.Item onSelect={ctx.onStartVoteCompose} icon={<Vote size={16} />}>
          Start a vote
        </MainMenu.Item>
      ) : null,
  },
  {
    id: "workshop-templates",
    order: 235,
    render: (ctx) =>
      ctx.canEdit ? (
        <>
          {WORKSHOP_TEMPLATES.map((template) => (
            <MainMenu.Item
              key={template.id}
              onSelect={() => ctx.onInsertTemplate(template.id)}
              icon={<LayoutTemplate size={16} />}
            >
              Insert: {template.label}
            </MainMenu.Item>
          ))}
        </>
      ) : null,
  },
  {
    id: "import-mind-map",
    order: 235,
    // Grouped with "Arrange" (same section, ordered just before it): both
    // are one-shot mind-map commands on the current board, not
    // document-wide settings.
    render: (ctx) =>
      ctx.canEdit ? (
        <MainMenu.Item
          onSelect={ctx.onOpenMindMapImport}
          icon={<FileInput size={16} />}
          data-testid="menu-import-mind-map"
        >
          Import mind map...
        </MainMenu.Item>
      ) : null,
  },
  {
    id: "arrange-mind-map",
    order: 240,
    // Grouped with the workshop actions above (vote, templates) rather than
    // canvas-actions below: like those, it is a deliberate one-shot command
    // on the current board content, not a document-wide setting.
    render: (ctx) =>
      ctx.canEdit ? (
        <MainMenu.Item
          onSelect={ctx.onArrangeMindMap}
          icon={<GitBranch size={16} />}
          data-testid="menu-arrange-mind-map"
        >
          Arrange
        </MainMenu.Item>
      ) : null,
  },
  { id: "canvas-actions-separator", order: 295, render: () => <MainMenu.Separator /> },
  { id: "clear-canvas", order: 300, render: () => <MainMenu.DefaultItems.ClearCanvas /> },
  {
    id: "change-canvas-background",
    order: 310,
    render: () => <MainMenu.DefaultItems.ChangeCanvasBackground />,
  },
  { id: "language-separator", order: 395, render: () => <MainMenu.Separator /> },
  {
    id: "language-selector",
    order: 400,
    render: (ctx) => (
      <MainMenu.ItemCustom>
        <LanguageSelector langCode={ctx.langCode} onChange={ctx.onSetLangCode} />
      </MainMenu.ItemCustom>
    ),
  },
  { id: "help-separator", order: 495, render: () => <MainMenu.Separator /> },
  // Last, deliberately (NIL-374): Excalidraw's floating "?" is the duplicate,
  // hidden in editorChrome.css, and this becomes the only remaining route.
  { id: "help", order: 500, render: () => <MainMenu.DefaultItems.Help /> },
];

/**
 * The top-right grey control group, alongside Excalidraw's own collaborator
 * avatars and Library trigger (EditorTopRight.tsx merges all three into one
 * bar via editorChrome.css). Empty on mobile: EditorTopRight returns null
 * there before this ever renders.
 */
export const HEADER_CONTROL_ENTRIES: HeaderControlSlotEntry[] = [
  {
    id: "invite-everyone-here",
    order: 20,
    zone: "presence",
    render: (ctx) =>
      ctx.canEdit && ctx.peers.length > 0 ? (
        <button
          onClick={ctx.inviteHere.invite}
          className="editor-header-control"
          aria-describedby="editor-invite-tooltip"
          aria-label={
            ctx.inviteHere.status
              ? `Invite everyone here; ${ctx.inviteHere.status.arrivedCount} arrived`
              : "Invite everyone here"
          }
          data-testid="editor-invite"
        >
          <LocateFixed size={16} />
          {ctx.inviteHere.status ? (
            <span className="editor-header-control__badge">
              {ctx.inviteHere.status.arrivedCount}
            </span>
          ) : null}
          <span
            id="editor-invite-tooltip"
            role="tooltip"
            className="editor-header-control__tooltip"
          >
            Invite everyone here
          </span>
        </button>
      ) : null,
  },
  {
    id: "share",
    order: 30,
    zone: "actions",
    render: (ctx) =>
      ctx.accessLevel === "owner" && ctx.id ? (
        <button
          onClick={ctx.onShareOpen}
          className="editor-header-control"
          aria-describedby="editor-share-tooltip"
          aria-label="Share"
          data-testid="editor-share"
        >
          <Share2 size={16} />
          <span id="editor-share-tooltip" role="tooltip" className="editor-header-control__tooltip">
            Share
          </span>
        </button>
      ) : null,
  },
];

/** No entries in this PR -- see the file comment's "An empty slot" section. */
export const FOOTER_ENTRIES: FooterSlotEntry[] = [];

/** Sort by `order`, render each entry into a keyed fragment -- shared by all three slot kinds below. */
const renderSorted = (entries: readonly SlotEntry[], ctx: ChromeSlotContext): React.ReactNode =>
  [...entries]
    .sort(byOrder)
    .map((entry) => <React.Fragment key={entry.id}>{entry.render(ctx)}</React.Fragment>);

export const renderMainMenuEntries = (ctx: ChromeSlotContext): React.ReactNode =>
  renderSorted(MAIN_MENU_ENTRIES, ctx);

export const renderHeaderControlEntries = (
  ctx: ChromeSlotContext,
  zone?: "presence" | "actions",
): React.ReactNode =>
  renderSorted(
    zone ? HEADER_CONTROL_ENTRIES.filter((entry) => entry.zone === zone) : HEADER_CONTROL_ENTRIES,
    ctx,
  );

export const renderFooterEntries = (ctx: ChromeSlotContext): React.ReactNode => {
  if (FOOTER_ENTRIES.length === 0) return null;
  return <Footer>{renderSorted(FOOTER_ENTRIES, ctx)}</Footer>;
};

export const followerNotice = (followers: readonly Follower[]): string | null =>
  describeFollowers(followers);
