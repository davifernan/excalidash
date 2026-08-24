import type React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { CommandPaletteProvider, useCommandPalette } from "./CommandPaletteContext";

const { isAuthenticated, authEnabled } = vi.hoisted(() => ({
  isAuthenticated: { current: true },
  authEnabled: { current: true },
}));

vi.mock("./AuthContext", () => ({
  useAuth: () => ({ isAuthenticated: isAuthenticated.current, authEnabled: authEnabled.current }),
}));

const Probe: React.FC = () => {
  const { isOpen, open, close } = useCommandPalette();
  return (
    <div>
      <span data-testid="probe-state">{isOpen ? "open" : "closed"}</span>
      <button onClick={open}>open-from-probe</button>
      <button onClick={close}>close-from-probe</button>
    </div>
  );
};

const Tree: React.FC = () => (
  <MemoryRouter>
    <CommandPaletteProvider>
      <Probe />
    </CommandPaletteProvider>
  </MemoryRouter>
);

const renderWithProvider = () => render(<Tree />);

describe("CommandPaletteProvider", () => {
  beforeEach(() => {
    isAuthenticated.current = true;
    authEnabled.current = true;
  });

  it("opens on Cmd/Ctrl+K and renders the palette dialog", () => {
    renderWithProvider();
    expect(screen.getByTestId("probe-state")).toHaveTextContent("closed");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    expect(screen.getByTestId("probe-state")).toHaveTextContent("open");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("toggles closed on a second Cmd/Ctrl+K", () => {
    renderWithProvider();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.getByTestId("probe-state")).toHaveTextContent("open");
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.getByTestId("probe-state")).toHaveTextContent("closed");
  });

  it("does nothing for an unauthenticated visitor on an auth-enabled instance (NIL-323/NIL-345)", () => {
    isAuthenticated.current = false;
    authEnabled.current = true;
    renderWithProvider();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.getByTestId("probe-state")).toHaveTextContent("closed");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("works with no user at all when the instance runs with auth disabled (NIL-323/NIL-345/NIL-346)", () => {
    // A no-auth instance (a supported deployment mode, and the e2e suite's
    // own default) never produces a `user`, so `isAuthenticated` stays
    // false there even though every route works with no login step --
    // same distinction ProtectedRoute.tsx already draws. Caught this
    // exact gap in a real browser (search-and-sort.spec.ts's Cmd+K test)
    // before it was caught here.
    isAuthenticated.current = false;
    authEnabled.current = false;
    renderWithProvider();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.getByTestId("probe-state")).toHaveTextContent("open");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("closes an already-open palette the moment auth flips false (logout mid-session, NIL-323/NIL-345)", () => {
    const { rerender } = renderWithProvider();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.getByTestId("probe-state")).toHaveTextContent("open");
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    isAuthenticated.current = false;
    rerender(<Tree />);

    expect(screen.getByTestId("probe-state")).toHaveTextContent("closed");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("open()/close() from context work directly, not just the shortcut", () => {
    renderWithProvider();
    fireEvent.click(screen.getByText("open-from-probe"));
    expect(screen.getByTestId("probe-state")).toHaveTextContent("open");
    act(() => {
      fireEvent.click(screen.getByText("close-from-probe"));
    });
    expect(screen.getByTestId("probe-state")).toHaveTextContent("closed");
  });
});
