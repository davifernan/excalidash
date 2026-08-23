import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useAuth } from "./AuthContext";
import { CommandPalette } from "../components/CommandPalette";

type CommandPaletteContextValue = {
  isOpen: boolean;
  open: () => void;
  close: () => void;
};

const CommandPaletteContext = createContext<CommandPaletteContextValue | null>(null);

/**
 * The one global Cmd/Ctrl+K listener (NIL-323/NIL-345).
 *
 * Mounted once at the app root (App.tsx), above the router's <Routes>, so
 * the palette itself and its keyboard shortcut both work identically from
 * Team Home, Dashboard, Settings, and inside the Canvas Shell (a MainMenu
 * entry there calls `open()` via this same context -- see
 * pages/editor/slots/commandPaletteMenuEntry.tsx). This replaces Dashboard's
 * old page-local Cmd+K-focuses-search-box behavior rather than running
 * alongside it; see the comment in useDashboardSelection.ts.
 *
 * Gated on `isAuthenticated`: an unauthenticated visitor (login page, or a
 * public /shared/:id link viewed while logged out) has no team/board list
 * to search, so the shortcut does nothing rather than opening an empty or
 * erroring palette.
 */
export const CommandPaletteProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated } = useAuth();
  const [isOpen, setIsOpen] = useState(false);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);

  useEffect(() => {
    if (!isAuthenticated) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setIsOpen((current) => !current);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isAuthenticated]);

  // A stale isOpen=true must not resurface the palette the instant auth
  // flips back to true later in the same session (logout then log back in
  // without a full page reload) -- close it the moment it does, rather than
  // relying on the render gate below alone to have caught it in time.
  useEffect(() => {
    if (!isAuthenticated && isOpen) setIsOpen(false);
  }, [isAuthenticated, isOpen]);

  const value = useMemo(() => ({ isOpen, open, close }), [isOpen, open, close]);

  return (
    <CommandPaletteContext.Provider value={value}>
      {children}
      {/* Gated here too, not just by the effect above: an effect runs after
          commit, so relying on it alone would still paint the palette for
          one frame on the render where auth just went false before its
          cleanup catches up. This gate makes that frame impossible instead
          of merely brief. */}
      {isAuthenticated && <CommandPalette isOpen={isOpen} onClose={close} />}
    </CommandPaletteContext.Provider>
  );
};

export const useCommandPalette = () => {
  const ctx = useContext(CommandPaletteContext);
  if (!ctx) throw new Error("useCommandPalette must be used within a CommandPaletteProvider");
  return ctx;
};
