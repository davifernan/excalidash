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
 * Gated on `canUse = authEnabled === false || isAuthenticated`, the same
 * condition `ProtectedRoute.tsx` uses to decide whether a route needs a
 * real session at all -- NOT on `isAuthenticated` alone. An instance
 * running with auth disabled entirely (a supported deployment mode, and
 * the e2e suite's own default) never produces a `user`, so
 * `isAuthenticated` (`!!user`) is permanently false there even though
 * every route works with no login step. Gating on it alone would have
 * silently disabled the palette for every no-auth instance -- caught by
 * `search-and-sort.spec.ts`'s Cmd+K test failing locally, not by any unit
 * test, because CommandPaletteContext.test.tsx mocks `useAuth()` directly
 * and never exercised the real `authEnabled === false` shape from
 * AuthContext. What `canUse` still correctly excludes: a genuinely
 * logged-out visitor on an auth-*enabled* instance (login page, or a
 * public /shared/:id link viewed while logged out) has no team/board list
 * to search, so the shortcut does nothing there rather than opening an
 * empty or erroring palette.
 */
export const CommandPaletteProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { authEnabled, isAuthenticated } = useAuth();
  const canUse = authEnabled === false || isAuthenticated;
  const [isOpen, setIsOpen] = useState(false);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);

  useEffect(() => {
    if (!canUse) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setIsOpen((current) => !current);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [canUse]);

  // A stale isOpen=true must not resurface the palette the instant this
  // flips back to true later in the same session (logout then log back in
  // without a full page reload) -- close it the moment it does, rather than
  // relying on the render gate below alone to have caught it in time.
  useEffect(() => {
    if (!canUse && isOpen) setIsOpen(false);
  }, [canUse, isOpen]);

  const value = useMemo(() => ({ isOpen, open, close }), [isOpen, open, close]);

  return (
    <CommandPaletteContext.Provider value={value}>
      {children}
      {/* Gated here too, not just by the effect above: an effect runs after
          commit, so relying on it alone would still paint the palette for
          one frame on the render where this just went false before its
          cleanup catches up. This gate makes that frame impossible instead
          of merely brief. */}
      {canUse && <CommandPalette isOpen={isOpen} onClose={close} />}
    </CommandPaletteContext.Provider>
  );
};

export const useCommandPalette = () => {
  const ctx = useContext(CommandPaletteContext);
  if (!ctx) throw new Error("useCommandPalette must be used within a CommandPaletteProvider");
  return ctx;
};
