/**
 * Opens the global Command Palette (NIL-323/NIL-345) from inside the Canvas
 * Shell.
 *
 * Cmd/Ctrl+K already opens the palette from every route, including this one
 * (CommandPaletteProvider's listener is mounted at the app root, above the
 * router, so it is not route-scoped) -- this entry exists for the mouse/
 * touch route to the same overlay, the same reason `back-to-dashboard` is a
 * menu item and not only a keyboard shortcut. Reads `useCommandPalette()`
 * directly rather than through `ChromeSlotContext`: the palette is app-wide
 * state, not board-scoped data the way the rest of the context is, so
 * routing it through the slot contract would grow the contract for
 * something that isn't actually about this board.
 */
import { Search } from "lucide-react";
import { EditorMenu as MainMenu } from "../../../integrations/excalidraw/slots";
import { useCommandPalette } from "../../../context/CommandPaletteContext";

// Not exported from @excalidraw/excalidraw's public types (only used
// internally in the package) -- same "CtrlOrCmd" display Excalidraw's own
// menu items use elsewhere, reproduced locally rather than reaching past
// the package's declared API for one string.
const shortcutLabel = /Mac|iPhone|iPod|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl+K";

export const SearchBoardsMenuEntry = () => {
  const { open } = useCommandPalette();
  return (
    <MainMenu.Item
      onSelect={open}
      icon={<Search size={16} />}
      shortcut={shortcutLabel}
      data-testid="menu-search-boards"
    >
      Search boards
    </MainMenu.Item>
  );
};
