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
 *   (EditorTopRight stands down there; its entry points live in the menu
 *   instead -- see EditorTopRight.tsx's own file comment for why).
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
 */
import React from "react";
import { ArrowLeft, Download, History, LocateFixed, Share2 } from "lucide-react";
import {
  EditorFooter as Footer,
  EditorMenu as MainMenu,
} from "../../integrations/excalidraw/slots";
import { LanguageSelector } from "../../components/LanguageSelector";
import { BoardNameMenuEntry } from "./slots/boardNameMenuEntry";
import type { InviteHereUiState } from "./InviteHereOverlay";
import type { Follower } from "./followMode";
import type { Peer } from "./useEditorCollaboration";

export type ChromeSlotContext = {
  id?: string;
  accessLevel: "none" | "view" | "edit" | "owner";
  canEdit: boolean;
  mobile: boolean;
  drawingName: string;
  isRenaming: boolean;
  isSavingOnLeave: boolean;
  newName: string;
  peers: readonly Peer[];
  followers: readonly Follower[];
  inviteHere: InviteHereUiState;
  langCode: string;
  onBackClick: () => void;
  onNewNameChange: (value: string) => void;
  onRenameBlur: () => void;
  onRenameStart: () => void;
  onRenameSubmit: (event: React.FormEvent) => void;
  onExportClick: () => void;
  onShareOpen: () => void;
  onHistoryOpen: () => void;
  onSetLangCode: (langCode: string) => void;
};

type SlotEntry = {
  id: string;
  order: number;
  render: (ctx: ChromeSlotContext) => React.ReactNode;
};

export type MainMenuSlotEntry = SlotEntry;
export type HeaderControlSlotEntry = SlotEntry;
export type FooterSlotEntry = SlotEntry;
export type OverlaySlotEntry = { id: string; render: (ctx: ChromeSlotContext) => React.ReactNode };

const byOrder = (a: SlotEntry, b: SlotEntry) => a.order - b.order || a.id.localeCompare(b.id);

const describeFollowers = (followers: readonly Follower[]): string | null => {
  if (followers.length === 0) return null;
  if (followers.length === 1) return `${followers[0].name} is following you`;
  return `${followers.length} people are following you`;
};

/**
 * The hamburger, top to bottom. Order 10-25 is this package's new lead-in
 * (board name, back route); everything from 100 on is what already lived in
 * the menu, renumbered with gaps so a later package can slot something
 * between two existing entries without renumbering the rest. Help sits last
 * on purpose (NIL-374): Excalidraw's own floating "?" is hidden in
 * editorChrome.css, so this is the only way to it.
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
    id: "back-to-dashboard",
    order: 20,
    render: (ctx) => (
      <MainMenu.Item onSelect={ctx.onBackClick} icon={<ArrowLeft size={16} />}>
        Back to dashboard
      </MainMenu.Item>
    ),
  },
  { id: "lead-in-separator", order: 25, render: () => <MainMenu.Separator /> },
  { id: "toggle-theme", order: 100, render: () => <MainMenu.DefaultItems.ToggleTheme /> },
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
  { id: "collab-separator", order: 195, render: () => <MainMenu.Separator /> },
  {
    id: "share",
    order: 200,
    render: (ctx) =>
      ctx.accessLevel === "owner" && ctx.id ? (
        <MainMenu.Item onSelect={ctx.onShareOpen} icon={<Share2 size={16} />}>
          Share
        </MainMenu.Item>
      ) : null,
  },
  {
    id: "invite-everyone-here",
    order: 210,
    // Mirrors EditorTopRight's own invite entry (order 20 there): the header
    // control disappears on mobile, so the same action needs a route in the
    // menu too. Two entries, one `inviteHere.invite` -- not a second feature.
    render: (ctx) =>
      ctx.canEdit && ctx.peers.length > 0 ? (
        <MainMenu.Item onSelect={ctx.inviteHere.invite} icon={<LocateFixed size={16} />}>
          Invite everyone here
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
    render: (ctx) =>
      ctx.canEdit && ctx.peers.length > 0 ? (
        <button
          onClick={ctx.inviteHere.invite}
          className="editor-header-control"
          title="Invite everyone here"
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
        </button>
      ) : null,
  },
  {
    id: "share",
    order: 30,
    render: (ctx) =>
      ctx.accessLevel === "owner" && ctx.id ? (
        <button
          onClick={ctx.onShareOpen}
          className="editor-header-control"
          title="Share"
          aria-label="Share"
          data-testid="editor-share"
        >
          <Share2 size={16} />
        </button>
      ) : null,
  },
];

/** No entries in this PR -- see the file comment's "An empty slot" section. */
export const FOOTER_ENTRIES: FooterSlotEntry[] = [];

export const renderMainMenuEntries = (ctx: ChromeSlotContext): React.ReactNode =>
  [...MAIN_MENU_ENTRIES]
    .sort(byOrder)
    .map((entry) => <React.Fragment key={entry.id}>{entry.render(ctx)}</React.Fragment>);

export const renderHeaderControlEntries = (ctx: ChromeSlotContext): React.ReactNode =>
  [...HEADER_CONTROL_ENTRIES]
    .sort(byOrder)
    .map((entry) => <React.Fragment key={entry.id}>{entry.render(ctx)}</React.Fragment>);

export const renderFooterEntries = (ctx: ChromeSlotContext): React.ReactNode => {
  if (FOOTER_ENTRIES.length === 0) return null;
  return (
    <Footer>
      {[...FOOTER_ENTRIES].sort(byOrder).map((entry) => (
        <React.Fragment key={entry.id}>{entry.render(ctx)}</React.Fragment>
      ))}
    </Footer>
  );
};

export const followerNotice = (followers: readonly Follower[]): string | null =>
  describeFollowers(followers);
